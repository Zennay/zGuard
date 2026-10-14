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
let deletions = 0;
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
      sendJson(res, 201, {
        token: syntheticToken, viewerUrl: '/s/' + syntheticToken + '/',
        maxMinutes: 15, expiresAt: Date.now() + 900_000
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/s/' + syntheticToken + '/') {
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
      sendJson(res, 200, { ok: true, expiresAt: Date.now() + 900_000 });
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

  health = 'busy';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser currently in use', 'browser-full status should not look ready');
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
  assert.equal(fixtureError, null, 'local fixture must not encounter unhandled errors');
  console.log('Real Chromium shipped TV portal acceptance passed: available/busy/offline/' +
    'recovery, reviewed sites, one guarded start, authenticated local iframe,' +
    ' completed load, one teardown and no duplicate allocation');
} finally {
  releaseStart?.();
  socket?.close();
  child.kill('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const stop = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(stop); resolve(); });
  });
  fs.rmSync(profile, { recursive: true, force: true });
  await new Promise(resolve => server.close(resolve));
}
