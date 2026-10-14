// Real Chromium UI acceptance for the shipped TV portal assets. All API and
// viewer responses are synthetic loopback fixtures; never touches a live
// zBrowse gateway, Docker daemon, public TV site or real session credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'zbrowse/gateway/public');
const sites = JSON.parse(fs.readFileSync(
  path.join(root, 'zbrowse/gateway/config/sites.json'), 'utf8'));
assert.ok(sites.length > 0, 'real portal acceptance requires reviewed start sites');
const binaries = [process.env.CHROMIUM_BIN,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  .filter(Boolean);
const browser = binaries.find(binary => spawnSync(binary, ['--version'], {
  timeout: 5000, encoding: 'utf8'
}).status === 0);
assert.ok(browser, 'real Chromium is mandatory: never silently skip portal browser QA');
assert.equal(typeof WebSocket, 'function', 'Node runtime must supply a CDP WebSocket');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const syntheticToken = 'T'.repeat(32);
const approvedStart = sites[0].url;
let health = 'ready';
let starts = 0;
let viewerResponseMode = 'valid';
let deletions = 0;
let viewerRequests = 0;
let heartbeats = 0;
let rejectHeartbeat = false;
let releaseStart = null;
let startRequestSeen = false;

function sendJson(res, code, data) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  }).end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(pathname)) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      const mime = pathname === '/' ? 'text/html' :
        pathname === '/app.js' ? 'application/javascript' : 'text/css';
      res.writeHead(200, { 'content-type': mime + '; charset=utf-8',
        'cache-control': 'no-store' }).end(fs.readFileSync(path.join(publicDir, file)));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/sites') {
      sendJson(res, 200, { sites, maxSessionMinutes: 15 });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      if (health === 'offline') {
        sendJson(res, 503, { error: 'Gateway unavailable' });
        return;
      }
      if (health === 'draining') {
        sendJson(res, 200, {
          status: 'draining', activeSessions: 0, startingSessions: 0, capacity: 1
        });
        return;
      }
      if (health === 'invalid') {
        // A successful HTTP response with a broken capacity contract must
        // never be mistaken for an available gateway in the real browser.
        sendJson(res, 200, {
          status: 'ok', activeSessions: '0', startingSessions: 0, capacity: 1
        });
        return;
      }
      sendJson(res, 200, {
        status: 'ok', activeSessions: health === 'busy' ? 1 : 0,
        startingSessions: 0, capacity: 1
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/session') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        assert.ok(raw.length <= 8192, 'browser UI must send bounded JSON');
      }
      assert.equal(JSON.parse(raw).url, approvedStart,
        'real portal must POST the selected approved URL');
      starts++;
      startRequestSeen = true;
      await new Promise(resolve => { releaseStart = resolve; });
      const viewerUrl = viewerResponseMode === 'external' ?
        'https://untrusted.invalid/viewer' :
        viewerResponseMode === 'javascript' ? 'javascript:alert(1)' :
        viewerResponseMode === 'mismatched-token' ? '/s/' + 'U'.repeat(32) + '/' :
        '/s/' + syntheticToken + '/';
      sendJson(res, 201, {
        token: syntheticToken, viewerUrl,
        maxMinutes: 15, expiresAt: viewerResponseMode === 'expired' ?
          Date.now() - 1000 : Date.now() + 900_000
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/s/' + syntheticToken + '/') {
      viewerRequests++;
      res.writeHead(200, { 'content-type': 'text/html',
        'cache-control': 'no-store' }).end('<!doctype html><title>Local synthetic viewer</title>');
      return;
    }
    if (req.method === 'DELETE' && pathname === '/api/session/' + syntheticToken) {
      deletions++;
      res.writeHead(204, { 'cache-control': 'no-store' }).end();
      return;
    }
    if (req.method === 'POST' &&
        pathname === '/api/session/' + syntheticToken + '/heartbeat') {
      heartbeats++;
      if (rejectHeartbeat) {
        sendJson(res, 410, { error: 'Synthetic session expired.' });
      } else {
        sendJson(res, 200, { ok: true, expiresAt: Date.now() + 900_000 });
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Local fixture route not found');
  } catch (error) {
    res.writeHead(500).end('Local fixture failed');
    fixtureError ||= error;
  }
});
let fixtureError = null;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zbrowse-tv-qa-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-sandbox', // ephemeral test Chrome only, NEVER production kiosk
  '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync',
  '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => {
  if (stderr.length < 4000) stderr += data.toString();
});
let socket;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  assert.ok(fs.existsSync(portFile),
    'test Chromium DevTools missing (exit=' + child.exitCode + '): ' + stderr.slice(-1500));
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  assert.ok(Number.isSafeInteger(port) && port > 0);
  let target;
  for (let i = 0; i < 60; i++) {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list');
    const targets = await response.json();
    target = targets.find(page => page.type === 'page' && page.url === 'about:blank');
    if (target?.webSocketDebuggerUrl) break;
    await sleep(100);
  }
  assert.ok(target?.webSocketDebuggerUrl, 'real browser page CDP target missing');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')),
      { once: true });
  });
  let nextId = 1;
  async function cdp(method, params = {}) {
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.removeEventListener('message', onMessage);
        reject(new Error('Chrome CDP timed out: ' + method));
      }, 10_000);
      function onMessage(event) {
        const packet = JSON.parse(event.data);
        if (packet.id !== id) return;
        socket.removeEventListener('message', onMessage);
        clearTimeout(timeout);
        if (packet.error) reject(new Error('CDP ' + method + ': ' + packet.error.message));
        else resolve(packet.result);
      }
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    assert.equal(result.exceptionDetails, undefined,
      'real TV browser JS must not raise an exception in: ' + expression.slice(0, 100));
    return result.result?.value;
  }
  async function until(predicate, label) {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await sleep(50);
    }
    assert.fail('real TV browser timed out: ' + label);
  }
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: origin + '/' });
  await until(async () => (await evaluate(
    'document.readyState === "complete" && !!document.getElementById("urlInput")'
  )), 'actual document load');
  await until(async () => (await evaluate(
    'document.getElementById("capacityText").textContent === "Ready to browse"'
  )), 'available capacity on the real page');
  assert.equal(await evaluate('document.getElementById("urlInput").value'),
    approvedStart, 'real browser must choose first reviewed URL');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
    sites.length, 'real UI must populate reviewed curated sites');

  // Drive only the real 30s heartbeat callback deterministically rather
  // than waiting wall-clock 30 seconds or duplicating the shipped handler.
  // The tested app.js remains unchanged and actually sends loopback HTTP.
  await evaluate(`(() => {
    const originalSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 30000) window.__qaHeartbeat = callback;
      return originalSetInterval(callback, delay, ...args);
    };
  })(); true`);

  health = 'busy';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser currently in use', 'browser-full status should not look ready');
  health = 'draining';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser temporarily unavailable', 'real UI must not advertise a draining gateway');
  assert.equal(await evaluate('document.getElementById("capacityText").parentElement.className'),
    'status', 'draining must not retain green readiness styling');
  health = 'invalid';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser engine offline', 'malformed 200 JSON must never appear as ready');
  health = 'offline';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser engine offline', 'gateway failure must differ from busy');
  health = 'ready';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Ready to browse', 'real portal must recover after temporary outage');

  await evaluate('document.getElementById("browserForm").requestSubmit();' +
    'document.getElementById("browserForm").requestSubmit(); true');
  await until(() => startRequestSeen, 'one actual session POST');
  assert.equal(starts, 1, 'double submit must never allocate two browser sessions');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    true, 'start button should remain locked while a browser is starting');
  assert.equal(await evaluate('document.getElementById("startButton").textContent'),
    'Starting…', 'real UI must render the pending state');
  assert.ok(releaseStart, 'synthetic backend start must be pending at this point');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'viewer visible after gateway start');
  assert.equal(await evaluate('new URL(document.getElementById("browserFrame").src).pathname'),
    '/s/' + syntheticToken + '/', 'viewer iframe must mount only the issued bearer path');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'viewer loading indicator clears after local iframe load');

  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === 1, 'one gateway capacity release');
  await until(async () => await evaluate(
    'document.getElementById("browserView").hidden && !document.getElementById("homeView").hidden'
  ), 'home returns after ending the viewer');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'ended viewer must discard its bearer iframe');
  await evaluate('document.getElementById("endButton").click(); true');
  await sleep(150);
  assert.equal(deletions, 1, 'repeated end must not double release');
  assert.equal(starts, 1, 'real TV UI must not accidentally allocate additional browsers');

  // A compromised/misconfigured session API must never cause browser
  // navigation to a malicious viewer, javascript: URL or another token.
  // These use the actual shipped DOM and iframe in real Chromium, rather
  // than calling checkedSessionPayload() in a VM with no browser.
  const unsafeViewerModes = ['external', 'javascript', 'mismatched-token'];
  for (const mode of unsafeViewerModes) {
    viewerResponseMode = mode;
    const before = starts;
    await evaluate('document.getElementById("browserForm").requestSubmit(); true');
    await until(() => starts === before + 1, mode + ' synthetic start attempt');
    assert.ok(releaseStart, mode + ': synthetic gateway response must be pending');
    releaseStart();
    releaseStart = null;
    await until(async () => await evaluate(
      'document.getElementById("formMessage").textContent === "Invalid browser session response."'
    ), mode + ': real browser must surface generic rejection');
    assert.equal(await evaluate('document.getElementById("browserView").hidden'),
      true, mode + ': rejected payload must never mount browser view');
    assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
      'about:blank', mode + ': rejected payload must not navigate viewer iframe');
    assert.equal(await evaluate(
      'state.session === null && state.heartbeat === null && state.countdown === null'
    ), true, mode + ': rejected payload must not retain session or timers');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      false, mode + ': retry must be available');
    assert.equal(deletions, 1,
      mode + ': rejected payload must not delete someone else\'s session');
  }

  // A response can be structurally valid yet already expired by the time
  // Chromium receives it. It must still release the server allocation but
  // must not even begin a GET for the expired bearer-bearing viewer iframe.
  viewerResponseMode = 'expired';
  const viewersBeforeExpiry = viewerRequests;
  const startsBeforeExpiry = starts;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === startsBeforeExpiry + 1,
    'local expired-browser response allocation');
  assert.ok(releaseStart, 'synthetic expiry must be returned through real HTTP');
  releaseStart();
  releaseStart = null;
  await until(() => deletions === 2,
    'expired response must immediately release the issued browser token');
  await sleep(200);
  assert.equal(viewerRequests, viewersBeforeExpiry,
    'expired session must never navigate to a bearer viewer, even transiently');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'expired session must keep browser iframe discarded');
  assert.equal(await evaluate(
    'state.session === null && state.heartbeat === null && state.countdown === null'
  ), true, 'expired response must not leave session heartbeat or countdown');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'),
    true, 'expired session must not display a browser');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    false, 'expired session must allow retry');

  // Exercise the actual browser session lease callback over HTTP.
  // Successful renewal must retain the mounted viewer; a 410 from the
  // gateway must immediately discard it and send one DELETE.
  viewerResponseMode = 'valid';
  const beforeLeaseStart = starts;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === beforeLeaseStart + 1, 'lease-tested session allocation');
  assert.ok(releaseStart, 'synthetic lease fixture must be waiting');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'lease-tested real browser mounted');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'lease-tested viewer loaded');
  assert.equal(await evaluate('typeof window.__qaHeartbeat'), 'function',
    'real browser must register the shipped 30000ms heartbeat callback');
  await evaluate('window.__qaHeartbeat(); true');
  await until(() => heartbeats === 1, 'successful real HTTP heartbeat');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'),
    false, 'successful heartbeat must not close a working browser');
  assert.equal(deletions, 2, 'successful lease renewal must not release a session');

  rejectHeartbeat = true;
  await evaluate('window.__qaHeartbeat(); true');
  await until(() => heartbeats === 2, 'rejected real HTTP heartbeat');
  await until(() => deletions === 3, 'rejected lease must trigger capacity release');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'),
    true, 'rejected lease must immediately return user to home');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'rejected lease must discard bearer viewer');
  assert.equal(await evaluate(
    'state.session === null && state.heartbeat === null && state.countdown === null'
  ), true, 'rejected lease must clear session and all lease timers');
  rejectHeartbeat = false;
  await sleep(150);
  assert.equal(deletions, 3, 'rejected heartbeat must not double-delete');

  // Browser-native page navigation must trigger the shipped pagehide
  // keepalive DELETE rather than leaving a session alive until TTL. This
  // validates genuine Chromium unload networking, not a VM-simulated event.
  viewerResponseMode = 'valid';
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === 7, 'valid retry after rejected gateway lease');
  assert.equal(deletions, 3, 'a pending fresh browser must not double-delete released sessions');
  assert.ok(releaseStart, 'second synthetic browser launch must be held at the backend');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'second browser mounted before top-level navigation');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'second local viewer completes iframe load');
  await cdp('Page.navigate', { url: 'about:blank' });
  await until(() => deletions === 4,
    'real Chromium pagehide sends keepalive session release after navigation');
  await sleep(150);
  assert.equal(deletions, 4, 'browser pagehide must release the final browser exactly once');
  assert.equal(starts, 7, 'only explicitly requested browser attempts should be sent');
  assert.equal(fixtureError, null, 'local fixture must not encounter unhandled errors');
  console.log('Real Chromium shipped TV portal acceptance passed: available/busy/offline/' +
    'draining/malformed health, recovery, reviewed sites, guarded starts, authenticated local iframe,' +
    ' completed load, manual teardown, browser-native pagehide keepalive DELETE,' +
    ' unsafe/expired-viewer rejection, heartbeat failure/retry, no duplicate allocation/release');
} finally {
  releaseStart?.();
  socket?.close();
  child.kill('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const stop = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(stop); resolve(); });
  });
  // Chrome's helper processes may flush profile files after its parent exits.
  // A bounded ENOTEMPTY/EBUSY retry avoids false-negative CI after every UI
  // assertion has already passed, without leaving a persistent test profile.
  await sleep(200);
  fs.rmSync(profile, {
    recursive: true, force: true, maxRetries: 15, retryDelay: 150
  });
  await new Promise(resolve => server.close(resolve));
}
