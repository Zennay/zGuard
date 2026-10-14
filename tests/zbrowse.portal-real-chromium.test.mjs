// Real Chromium UI acceptance for the shipped TV portal assets. All API and
// viewer responses are synthetic loopback fixtures; never touches a live
// zBrowse gateway, Docker daemon, public TV site or real session credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { gzipSync, brotliCompressSync } from 'node:zlib';
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

// DevToolsActivePort can exist before Chromium finishes writing its value.
// A partially written file must not cause a false-negative real-browser test.
function parseDevToolsPort(source) {
  const firstLine = source.split(/\r?\n/, 1)[0];
  if (!/^[1-9][0-9]{0,4}$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return port <= 65535 ? port : null;
}
for (const [sample, expected] of [
  ['', null], ['0\n', null], ['\n/devtools/browser', null],
  ['48920\n/devtools/browser/example', 48920],
  ['65536\n', null], ['17extra\n', null]
]) {
  assert.equal(parseDevToolsPort(sample), expected,
    'TV Chrome debugger port parser must reject partial/malformed files');
}
const syntheticToken = 'T'.repeat(32);
const approvedStart = sites[0].url;
let health = 'ready';
let sitesMode = 'ready';
let stalledSiteGets = 0;
let stalledHealthGets = 0;
let stalledSiteBodies = 0;
let stalledHealthBodies = 0;
let healthCacheControl = 'no-store';
let nextHealthStatus = null;
let nextSitesStatus = null;
let nextHealthMediaType = null;
let nextSitesMediaType = null;
let starts = 0;
let viewerResponseMode = 'valid';
let nextStartFailure = null;
let nextStartMediaType = null;
let nextStartStatus = null;
let deletions = 0;
let failNextDelete = false;
let droppedDeleteAttemptsRemaining = 0;
let holdNextDelete = false;
let releaseHeldDelete = null;
let notifyHeldDelete = null;
let viewerRequests = 0;
let heartbeats = 0;
let rejectHeartbeat = false;
let hangNextHeartbeat = false;
let hungHeartbeatCalls = 0;
let nextHeartbeatReply = null;
let deleteAlreadyGone = false;
let nextDeleteProxyError = null;
let releaseStart = null;
let startRequestSeen = false;

function sendJson(res, code, data, cacheControl = 'no-store') {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl
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
      if (sitesMode === 'hang-once') {
        // Keep exactly one synthetic HTTP read pending until Chrome aborts it.
        // No public gateway, production token or Docker connection is made.
        sitesMode = 'ready';
        stalledSiteGets++;
        return;
      }
      if (sitesMode === 'hang-body-once') {
        // HTTP 200 and JSON headers arrive, but the first chunk never ends.
        // Browser must timeout after headers, not only while awaiting fetch.
        sitesMode = 'ready';
        stalledSiteBodies++;
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        });
        res.write(' ');
        return;
      }
      if (sitesMode === 'oversized-error') {
        sendJson(res, 502, { error: 'Upstream failure', padding: 'x'.repeat(75000) });
      } else if (sitesMode === 'oversized-stream') {
        // Node sends chunked HTTP without Content-Length; Chrome must stop
        // after 64KiB even when the JSON contains a plausible curated list.
        sendJson(res, 200, { sites, maxSessionMinutes: 15, padding: 'x'.repeat(70000) });
      } else if (sitesMode === 'compressed-bomb') {
        const decoded = JSON.stringify({
          sites, maxSessionMinutes: 15, padding: 'x'.repeat(70000)
        });
        const wire = brotliCompressSync(Buffer.from(decoded));
        assert.ok(wire.byteLength < 65536,
          'Brotli fixture must advertise fewer wire bytes than catalogue limit');
        res.writeHead(200, {
          'content-type': 'application/json', 'content-encoding': 'br',
          'content-length': String(wire.byteLength), 'cache-control': 'no-store'
        }).end(wire);
      } else if (sitesMode === 'offline') {
        sendJson(res, 503, { error: 'Synthetic catalogue unavailable' });
      } else if (sitesMode === 'userinfo') {
        sendJson(res, 200, {
          sites: [{ name: 'Injected fixture', url: 'https://user:secret@fawesome.tv/' }],
          maxSessionMinutes: 15
        });
      } else if (sitesMode === 'empty') {
        sendJson(res, 200, { sites: [], maxSessionMinutes: 15 });
      } else if (sitesMode === 'many') {
        sendJson(res, 200, {
          sites: Array.from({ length: 33 }, (_, i) =>
            ({ name: 'Fake #' + i, url: 'https://site' + i + '.invalid/' })),
          maxSessionMinutes: 15
        });
      } else if (sitesMode === 'long-name') {
        sendJson(res, 200, { sites: [
          { name: 'A'.repeat(97), url: sites[0].url }
        ], maxSessionMinutes: 15 });
      } else if (sitesMode === 'long-url') {
        sendJson(res, 200, { sites: [
          { name: 'Long URL', url: sites[0].url + 'x'.repeat(2050) }
        ], maxSessionMinutes: 15 });
      } else if (sitesMode === 'bidi-name') {
        sendJson(res, 200, { sites: [
          { name: 'Video\u202Efake.invalid', url: sites[0].url }
        ], maxSessionMinutes: 15 });
      } else if (['duplicate-label', 'casefold-label', 'fullwidth-label'].includes(sitesMode)) {
        const duplicate = {
          'duplicate-label': 'Fawesome',
          'casefold-label': 'FAWESOME',
          'fullwidth-label': '\uFF26\uFF41\uFF57\uFF45\uFF53\uFF4F\uFF4D\uFF45'
        }[sitesMode];
        sendJson(res, 200, { sites: [
          { name: 'Fawesome', url: sites[0].url },
          { name: duplicate, url: 'https://another-curated.invalid/' }
        ], maxSessionMinutes: 15 });
      } else if (['c1-label', 'arabic-mark-label', 'rtl-mark-label',
        'paragraph-separator-label', 'zero-width-label', 'soft-hyphen-label',
        'word-joiner-label', 'bom-label'].includes(sitesMode)) {
        const mark = {
          'c1-label': '\u0085',
          'arabic-mark-label': '\u061c',
          'rtl-mark-label': '\u200f',
          'paragraph-separator-label': '\u2029',
          'zero-width-label': '\u200b',
          'soft-hyphen-label': '\u00ad',
          'word-joiner-label': '\u2060',
          'bom-label': '\ufeff'
        }[sitesMode];
        sendJson(res, 200, { sites: [
          { name: 'Video' + mark + 'spoofed.invalid', url: sites[0].url }
        ], maxSessionMinutes: 15 });
      } else {
        const status = nextSitesStatus ?? 200;
        nextSitesStatus = null;
        if (nextSitesMediaType !== null) {
          const media = nextSitesMediaType;
          nextSitesMediaType = null;
          res.writeHead(status, {
            ...(media === 'missing' ? {} : { 'content-type': media }),
            'cache-control': 'no-store'
          }).end(JSON.stringify({ sites, maxSessionMinutes: 15 }));
        } else {
          sendJson(res, status, { sites, maxSessionMinutes: 15 });
        }
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      if (health === 'hang-once') {
        health = 'ready';
        stalledHealthGets++;
        return;
      }
      if (health === 'hang-body-once') {
        health = 'ready';
        stalledHealthBodies++;
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        });
        res.write(' ');
        return;
      }
      if (health === 'oversized-error') {
        sendJson(res, 502, { error: 'Upstream failure', padding: 'x'.repeat(8000) });
        return;
      }
      if (health === 'oversized-stream') {
        sendJson(res, 200, {
          status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1,
          padding: 'x'.repeat(5000)
        });
        return;
      }
      if (health === 'compressed-bomb') {
        const decoded = JSON.stringify({
          status: 'ok', activeSessions: 0, startingSessions: 0, capacity: 1,
          padding: 'x'.repeat(5000)
        });
        const wire = gzipSync(Buffer.from(decoded));
        assert.ok(wire.byteLength < 4096,
          'gzip fixture must advertise fewer wire bytes than health limit');
        res.writeHead(200, {
          'content-type': 'application/json', 'content-encoding': 'gzip',
          'content-length': String(wire.byteLength), 'cache-control': 'no-store'
        }).end(wire);
        return;
      }
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
      const status = nextHealthStatus ?? 200;
      nextHealthStatus = null;
      const payload = {
        status: 'ok', activeSessions: health === 'busy' ? 1 : 0,
        startingSessions: 0, capacity: 1
      };
      if (nextHealthMediaType !== null) {
        const media = nextHealthMediaType;
        nextHealthMediaType = null;
        res.writeHead(status, {
          ...(media === 'missing' ? {} : { 'content-type': media }),
          'cache-control': 'no-store'
        }).end(JSON.stringify(payload));
      } else {
        sendJson(res, status, payload, healthCacheControl);
      }
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
      if (nextStartFailure) {
        const { status, error } = nextStartFailure;
        nextStartFailure = null;
        sendJson(res, status, { error });
        return;
      }
      await new Promise(resolve => { releaseStart = resolve; });
      const viewerUrl = viewerResponseMode === 'external' ?
        'https://untrusted.invalid/viewer' :
        viewerResponseMode === 'javascript' ? 'javascript:alert(1)' :
        viewerResponseMode === 'mismatched-token' ? '/s/' + 'U'.repeat(32) + '/' :
        '/s/' + syntheticToken + '/';
      const payload = {
        token: syntheticToken, viewerUrl,
        maxMinutes: viewerResponseMode === 'duration-mismatch' ? 1 : 15,
        expiresAt: viewerResponseMode === 'expired' ? Date.now() - 1000 :
          viewerResponseMode === 'overlong-lease' ? Date.now() + 3_600_000 :
          Date.now() + 900_000
      };
      const successStatus = nextStartStatus ?? 201;
      nextStartStatus = null;
      if (nextStartMediaType !== null) {
        const mediaType = nextStartMediaType;
        nextStartMediaType = null;
        res.writeHead(successStatus, {
          ...(mediaType === 'missing' ? {} : { 'content-type': mediaType }),
          'cache-control': 'no-store'
        }).end(JSON.stringify(payload));
      } else {
        sendJson(res, successStatus, payload);
      }
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
      if (holdNextDelete) {
        holdNextDelete = false;
        await new Promise(resolve => {
          releaseHeldDelete = resolve;
          notifyHeldDelete?.();
        });
      }
      if (droppedDeleteAttemptsRemaining > 0) {
        // Chrome may retry an idempotent DELETE after a connection reset.
        // Drop each transport retry within this *bounded fixture window*.
        // No HTTP status or response body reaches the browser.
        droppedDeleteAttemptsRemaining--;
        res.socket.destroy();
        return;
      }
      if (nextDeleteProxyError) {
        // Mimic an ingress route failure: this HTTP reply proves nothing
        // about whether the gateway's actual browser is still running.
        const mode = nextDeleteProxyError;
        nextDeleteProxyError = null;
        if (mode === 'html-404') {
          res.writeHead(404, { 'content-type': 'text/html' })
            .end('<!doctype html><title>Proxy route missing</title>');
        } else if (mode === 'json-body-html-404') {
          res.writeHead(404, { 'content-type': 'text/html' })
            .end(JSON.stringify({ error: 'Session not found.' }));
        } else if (mode === 'json-410') {
          sendJson(res, 410, { error: 'Reverse proxy route gone' });
        } else if (mode === 'json-200') {
          sendJson(res, 200, { ok: true });
        } else if (mode === 'html-200') {
          res.writeHead(200, { 'content-type': 'text/html' })
            .end('<!doctype html><title>Proxy success, browser still alive</title>');
        } else if (mode === 'json-202') {
          sendJson(res, 202, { ok: true });
        } else if (mode === 'json-206') {
          sendJson(res, 206, { ok: true });
        } else {
          throw new Error('Unknown synthetic proxy error');
        }
        return;
      }
      if (failNextDelete) {
        failNextDelete = false;
        sendJson(res, 503, { error: 'Synthetic teardown failure' });
        return;
      }
      if (deleteAlreadyGone) {
        deleteAlreadyGone = false;
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      res.writeHead(204, { 'cache-control': 'no-store' }).end();
      return;
    }
    if (req.method === 'POST' &&
        pathname === '/api/session/' + syntheticToken + '/heartbeat') {
      heartbeats++;
      if (hangNextHeartbeat) {
        hangNextHeartbeat = false;
        hungHeartbeatCalls++;
        // Hold the real loopback HTTP response until the browser's own
        // 10-second lease deadline aborts it. No Docker or VPS involved.
        return;
      }
      if (nextHeartbeatReply) {
        const reply = nextHeartbeatReply;
        nextHeartbeatReply = null;
        if (reply.status === 204) {
          res.writeHead(204, { 'cache-control': 'no-store' }).end();
        } else if (reply.mediaType) {
          res.writeHead(reply.status, {
            'content-type': reply.mediaType,
            'cache-control': 'no-store'
          }).end(JSON.stringify(reply.body));
        } else {
          sendJson(res, reply.status, reply.body);
        }
        return;
      }
      if (rejectHeartbeat) {
        // Shipped gateway rejects DELETE with 404 after lease expiry.
        // A second DELETE cannot make an already expired token more dead.
        deleteAlreadyGone = true;
        // Oversized error diagnostics must not be parsed by the kiosk.
        sendJson(res, 410, { error: 'Synthetic session expired.' + 'x'.repeat(80000) });
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
  let port = null;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(portFile)) {
      try {
        port = parseDevToolsPort(fs.readFileSync(portFile, 'utf8'));
      } catch (error) {
        // A new profile file may be replaced between existsSync and read.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (port !== null || child.exitCode !== null) break;
    await sleep(100);
  }
  assert.ok(port !== null,
    'test Chromium did not publish a valid CDP port (exit=' + child.exitCode +
      '): ' + stderr.slice(-1500));
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
  async function until(predicate, label, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
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
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    false, 'ready gateway must enable the actual Open button');
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

  // End-to-end browser fetch over real chunked HTTP: a proxy can return
  // a syntactically valid but oversized JSON 200 without Content-Length.
  // This is the shipped TV's parser, not only the independent release probe.
  health = 'oversized-stream';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser engine offline', 'oversized chunked health must fail closed in real Chromium');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'oversized health cannot enable a new browser');
  assert.equal(starts, 0, 'oversized health must never allocate a browser');
  health = 'ready';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'valid gateway health should restore browsing after oversized HTTP');
  sitesMode = 'oversized-stream';
  await evaluate('siteCatalogueReady = false; ensureSiteCatalogue()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'oversized chunked catalogue must lock browser admission');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'), 0,
    'oversized catalogue must not render any untrusted choices');
  assert.equal(starts, 0, 'oversized catalogue may not create browsers');
  sitesMode = 'ready';
  await evaluate('ensureSiteCatalogue()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'canonical bounded catalogue must restore browser admission');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
    sites.length, 'reviewed site suggestions return only after bounded JSON read');

  // CDNs can return tiny compressed transfers that inflate far beyond
  // reviewed 4KiB/64KiB JSON budgets. This must be proven in actual Chrome,
  // not just against Node's independent release-readiness endpoint.
  health = 'compressed-bomb';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser engine offline',
    'real Chrome must reject decoded gzip health beyond 4KiB');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'gzip expansion must never advertise healthy browser capacity');
  assert.equal(starts, 0,
    'gzip expansion must not start a browser');
  health = 'ready';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'uncompressed valid health must recover after gzip expansion rejection');

  sitesMode = 'compressed-bomb';
  await evaluate('siteCatalogueReady = false; ensureSiteCatalogue()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'real Chrome must reject decoded Brotli catalogue beyond 64KiB');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'), 0,
    'Brotli expansion must never show unreviewed site choices');
  assert.equal(starts, 0,
    'Brotli expansion must not start a viewer');
  sitesMode = 'ready';
  await evaluate('ensureSiteCatalogue()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'reviewed site catalogue must recover after Brotli expansion rejection');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
    sites.length, 'reviewed choices must recover after Brotli expansion');

  // Untrusted large HTTP error bodies should fail closed without being
  // parsed by the TV. Test actual browser fetch and origin HTTP, then prove
  // a healthy GET restores Open rather than poisoning future navigation.
  health = 'oversized-error';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser engine offline', 'chunked 502 health must not claim readiness');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'failed health must disable real Open');
  health = 'ready';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'valid recovery GET must restore Open after large health error');
  sitesMode = 'oversized-error';
  await evaluate('siteCatalogueReady = false; ensureSiteCatalogue()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'oversized 502 site error must lock browser admission');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
    0, 'failed catalogue must never render spoofed choices');
  assert.equal(starts, 0, 'failed read-only gateway responses cannot allocate browsers');
  sitesMode = 'ready';
  await evaluate('ensureSiteCatalogue()');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'canonical site JSON restores reviewed browser admission');

  // Real Chromium/loopback GETs: misleading proxy 202/206 JSON may carry
  // superficially valid health or curated sites, but cannot unlock Open.
  // Recovery on documented HTTP 200 is an equally mandatory positive control.
  for (const status of [202, 206]) {
    nextHealthStatus = status;
    await evaluate('refreshHealth()');
    assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
      'Browser engine offline', status + ': non-200 health must fail closed in Chrome');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      true, status + ': unsafe health status must disable real Open button');
    assert.equal(starts, 0, 'unsafe HTTP health must not mint a browser');
    await evaluate('refreshHealth()');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      false, status + ': canonical HTTP 200 health must recover Open');
    nextSitesStatus = status;
    await evaluate('siteCatalogueReady = false; ensureSiteCatalogue()');
    assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
      0, status + ': unsafe catalogue cannot render unreviewed suggestions');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      true, status + ': unsafe catalogue must lock browser start');
    assert.equal(starts, 0, 'unsafe catalogue must not allocate a browser');
    await evaluate('ensureSiteCatalogue()');
    assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
      sites.length, status + ': canonical 200 catalogue should restore suggestions');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      false, status + ': canonical 200 catalogue must restore Open');
  }

  // Actual Chrome fetch parses these JSON bodies, but their declared
  // Content-Type is wrong. Do not trust them for browser admission. A later
  // canonical gateway application/json response must restore normal use.
  for (const media of ['text/html', 'application/problem+json', 'missing']) {
    nextHealthMediaType = media;
    await evaluate('refreshHealth()');
    assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
      'Browser engine offline', media + ': real HTTP mislabeled health must fail closed');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      true, media + ': mislabeled health must not enable Open');
    assert.equal(starts, 0, media + ': invalid health must not start browsers');
    await evaluate('refreshHealth()');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      false, media + ': canonical JSON health should restore browsing');
    nextSitesMediaType = media;
    await evaluate('siteCatalogueReady = false; ensureSiteCatalogue()');
    assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
      0, media + ': untrusted catalogue cannot show suggestions');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      true, media + ': untrusted catalogue cannot unlock Open');
    await evaluate('ensureSiteCatalogue()');
    assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
      sites.length, media + ': valid JSON catalogue restores reviewed list');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'),
      false, media + ': valid JSON catalogue restores normal Open');
  }

  // Simulate an erroneously cacheable 200/OK gateway-health response.
  // Even if origin/CDN policy drifts, the TV client must fetch fresh capacity
  // rather than serving a cached busy/ready answer from browser HTTP cache.
  healthCacheControl = 'public, max-age=3600';
  health = 'busy';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser currently in use', 'browser-full status should not look ready');
  health = 'ready';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Ready to browse', 'cacheable previous busy health must not override real ready state');
  healthCacheControl = 'no-store';
  health = 'busy';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser currently in use', 'fresh busy gateway health must not be replaced by cached ready');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    false, 'busy gateway must permit owner session reuse attempt');
  // A real TV keyboard can still submit a form by pressing Enter in the
  // address field when the visible Open button is disabled. Exercise that
  // browser path, not just a scripted form.requestSubmit() call.
  async function nativeEnterWhileUnavailable(label) {
    const focused = await evaluate(`(() => {
      const input = document.getElementById("urlInput");
      window.__qaUnavailableNativeEnter = false;
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") window.__qaUnavailableNativeEnter = event.isTrusted;
      }, { once: true });
      input.focus();
      return document.activeElement === input;
    })()`);
    assert.equal(focused, true, label + ': address input must be keyboard focusable');
    for (const type of ['keyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
      });
    }
    await sleep(110);
    assert.equal(await evaluate('window.__qaUnavailableNativeEnter'), true,
      label + ': real Chrome must deliver trusted Enter to the URL input');
    assert.equal(starts, 0, label + ': native Enter must not allocate a remote browser');
  }

  // A disabled Open button must also suppress real Chrome pointer activation.
  // A scripted disabled property check alone cannot prove that a mouse or TV
  // pointer will not dispatch a start click while the backend is unavailable.
  async function nativePointerWhileUnavailable(label) {
    const setup = await evaluate(`(() => {
      const button = document.getElementById("startButton");
      window.__qaDisabledOpenClicked = false;
      button.addEventListener("click", () => {
        window.__qaDisabledOpenClicked = true;
      }, { once: true });
      button.scrollIntoView({ block: "center" });
      const bounds = button.getBoundingClientRect();
      return { disabled: button.disabled,
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2 };
    })()`);
    assert.equal(setup.disabled, true, label + ': Open must be disabled before pointer hit');
    assert.ok(Number.isFinite(setup.x) && Number.isFinite(setup.y),
      label + ': disabled button must remain physically hit-testable');
    for (const params of [
      { type: 'mouseMoved', button: 'none', buttons: 0 },
      { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 }
    ]) {
      await cdp('Input.dispatchMouseEvent', { x: setup.x, y: setup.y, ...params });
    }
    await sleep(90);
    assert.equal(await evaluate('window.__qaDisabledOpenClicked'), false,
      label + ': native pointer must not dispatch a click on disabled Open');
    assert.equal(starts, 0, label + ': pointer must not allocate browser while unavailable');
  }

  health = 'draining';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser temporarily unavailable', 'real UI must not advertise a draining gateway');
  assert.equal(await evaluate('document.getElementById("capacityText").parentElement.className'),
    'status', 'draining must not retain green readiness styling');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    true, 'draining must disable browser start in real Chromium');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await sleep(100);
  assert.equal(starts, 0,
    'even scripted form submission must not allocate a browser during drain');
  await nativeEnterWhileUnavailable('draining');
  await nativePointerWhileUnavailable('draining');
  health = 'invalid';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser engine offline', 'malformed 200 JSON must never appear as ready');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    true, 'malformed health response must deny browser admission');
  await nativeEnterWhileUnavailable('invalid-health');
  health = 'offline';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser engine offline', 'gateway failure must differ from busy');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    true, 'HTTP 503 should prevent a doomed browser POST');
  await nativeEnterWhileUnavailable('gateway-offline');
  await nativePointerWhileUnavailable('gateway-offline');
  health = 'ready';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Ready to browse', 'real portal must recover after temporary outage');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'),
    false, 'successful recovery must immediately re-enable Open');

  // Exercise genuine Chromium Space keyboard activation rather than relying only
  // on synthetic form.requestSubmit(). A second scripted submit while the
  // first request is pending must still be rejected by the shipped UI.
  const focusedStart = await evaluate(`(() => {
    const button = document.getElementById("startButton");
    window.__qaPortalKeyboard = {
      startKeyTrusted: false, submitTrusted: false, endKeyTrusted: false
    };
    button.addEventListener("keydown", event => {
      if (event.key === " ") window.__qaPortalKeyboard.startKeyTrusted = event.isTrusted;
    }, { once: true });
    document.getElementById("browserForm").addEventListener("submit", event => {
      window.__qaPortalKeyboard.submitTrusted = event.isTrusted;
    }, { once: true });
    button.focus();
    return document.activeElement === button;
  })()`);
  assert.equal(focusedStart, true, 'start button must be focusable in real Chromium');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32
    });
  }
  // Prove the native key activated the form BEFORE any programmatic retry.
  // Otherwise the scripted requestSubmit below could create a false PASS.
  await until(() => startRequestSeen, 'one native Space-triggered session POST');
  assert.equal(await evaluate(
    'window.__qaPortalKeyboard.startKeyTrusted && window.__qaPortalKeyboard.submitTrusted'
  ), true, 'native Space activation must dispatch a trusted submit event');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
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
  assert.equal(await evaluate(
    'document.activeElement?.id === "fullscreenButton"'
  ), true, 'real Chromium must focus visible TV toolbar after hiding the Open form');
  assert.equal(await evaluate(
    'document.activeElement?.closest("#homeView") === null'
  ), true, 'real Chromium focus must never remain inside hidden home controls');
  assert.equal(await evaluate('new URL(document.getElementById("browserFrame").src).pathname'),
    '/s/' + syntheticToken + '/', 'viewer iframe must mount only the issued bearer path');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'viewer loading indicator clears after local iframe load');

  // Test the actual TV viewer toolbar at narrow remote-control viewports.
  // A fullscreen control outside the viewport can still pass DOM presence
  // checks while a real user cannot hit it or reach End session.
  for (const width of [320, 375, 680, 1280]) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width, height: 568, deviceScaleFactor: 1, mobile: false
    });
    const layout = await evaluate(`(() => {
      const toolbar = document.querySelector('.browser-toolbar');
      const ids = ['fullscreenButton', 'endButton'];
      return {
        viewport: window.innerWidth,
        visible: !document.getElementById('browserView').hidden,
        toolbarWidth: toolbar.clientWidth,
        toolbarScrollWidth: toolbar.scrollWidth,
        controls: ids.map(id => {
          const button = document.getElementById(id);
          const box = button.getBoundingClientRect();
          return {
            id, left: box.left, right: box.right,
            hit: document.elementFromPoint(
              box.left + box.width / 2, box.top + box.height / 2
            ) === button
          };
        })
      };
    })()`);
    assert.equal(layout.viewport, width,
      'Chromium test must actually emulate requested TV viewport');
    assert.equal(layout.visible, true,
      'viewer should remain visible across viewport changes');
    assert.ok(layout.toolbarScrollWidth <= layout.toolbarWidth + 1,
      width + 'px TV toolbar must not clip its contents');
    for (const control of layout.controls) {
      assert.ok(control.left >= 0 && control.right <= width + 1 && control.hit,
        width + 'px TV toolbar must keep ' + control.id + ' physically reachable: ' +
          JSON.stringify(control));
    }
    assert.equal(starts, 1, 'viewport changes must not start extra sessions');
  }
  await cdp('Emulation.clearDeviceMetricsOverride');

  // Actual Fullscreen API + trusted keyboard activation: fullscreen on the
  // iframe-only stage would hide the toolbar and strand TV users. Chrome must
  // retain real keyboard-accessible Exit fullscreen and End session controls.
  const fullscreenFocused = await evaluate('(() => { const b = document.getElementById("fullscreenButton"); b.focus(); return document.activeElement === b; })()');
  assert.equal(fullscreenFocused, true, 'TV fullscreen control must accept focus');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32
    });
  }
  await until(async () => await evaluate(
    'document.fullscreenElement?.id === "browserView"'
  ), 'real Chrome fullscreen includes the browser toolbar');
  assert.deepEqual(await evaluate(`(() => {
    const root = document.fullscreenElement;
    const toggle = document.getElementById("fullscreenButton");
    const end = document.getElementById("endButton");
    const frame = document.getElementById("browserFrame");
    const rect = toggle.getBoundingClientRect();
    return {
      toolbarInside: root.contains(toggle),
      endInside: root.contains(end),
      iframeInside: root.contains(frame),
      toggleHitTest: document.elementFromPoint(rect.left + rect.width / 2,
        rect.top + rect.height / 2) === toggle,
      toggleLabel: toggle.textContent,
      pressed: toggle.getAttribute("aria-pressed")
    };
  })()`), {
    toolbarInside: true, endInside: true, iframeInside: true,
    toggleHitTest: true, toggleLabel: 'Exit fullscreen', pressed: 'true'
  }, 'full-screen TV stream must retain visible interactive toolbar controls');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32
    });
  }
  await until(async () => await evaluate(
    'document.fullscreenElement === null'
  ), 'real Chrome fullscreen exit through its visible toolbar');
  await until(async () => await evaluate(
    'document.getElementById("fullscreenButton").textContent === "Fullscreen" && ' +
    'document.getElementById("fullscreenButton").getAttribute("aria-pressed") === "false"'
  ), 'fullscreen exit updates its accessible toolbar state');
  assert.equal(await evaluate('document.getElementById("fullscreenButton").textContent'),
    'Fullscreen', 'fullscreen exit restores control label');
  assert.equal(starts, 1, 'fullscreen toggles must not create a second browser session');

  // TV viewers must be able to leave the stream controls with real Escape
  // and land on End session without searching for the button with a pointer.
  // Start from a different focused toolbar control, not a scripted End focus.
  const focusedToolbar = await evaluate(`(() => {
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") window.__qaPortalKeyboard.escapeTrusted = event.isTrusted;
    }, { once: true });
    const button = document.getElementById("fullscreenButton");
    button.focus();
    return document.activeElement === button;
  })()`);
  assert.equal(focusedToolbar, true,
    'fullscreen toolbar control must be keyboard focusable before Escape');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
  }
  const focusedEnd = await evaluate(`(() => {
    const button = document.getElementById("endButton");
    button.addEventListener("keydown", event => {
      if (event.key === " ") window.__qaPortalKeyboard.endKeyTrusted = event.isTrusted;
    }, { once: true });
    button.addEventListener("click", event => {
      window.__qaPortalKeyboard.endClickTrusted = event.isTrusted;
      window.__qaPortalKeyboard.endClickSeen = true;
    }, { once: true });
    return document.activeElement === button;
  })()`);
  assert.equal(await evaluate('window.__qaPortalKeyboard.escapeTrusted'), true,
    'Escape key must be delivered as a trusted browser event');
  assert.equal(focusedEnd, true,
    'real Escape must focus End session before Space activates it');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32
    });
  }
  await sleep(150);
  const keyboardEnd = await evaluate(`({
    key: window.__qaPortalKeyboard.endKeyTrusted,
    click: window.__qaPortalKeyboard.endClickSeen === true,
    trustedClick: window.__qaPortalKeyboard.endClickTrusted === true,
    active: document.activeElement?.id === "endButton",
    viewerHidden: document.getElementById("browserView").hidden
  })`);
  assert.deepEqual(keyboardEnd, {
    key: true, click: true, trustedClick: true, active: false, viewerHidden: true
  }, 'native Space must trigger a real trusted button click and hide the viewer');
  await until(() => deletions === 1, 'one Space-triggered gateway capacity release');
  assert.equal(await evaluate('window.__qaPortalKeyboard.endKeyTrusted'),
    true, 'End session must receive a native trusted Space key');
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
  const unsafeViewerModes = ['external', 'javascript', 'mismatched-token',
    'overlong-lease', 'duration-mismatch'];
  for (const mode of unsafeViewerModes) {
    viewerResponseMode = mode;
    const before = starts;
    const beforeInvalidRelease = deletions;
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
    await until(() => deletions === beforeInvalidRelease + 1,
      mode + ': a valid minted token needs one immediate release despite rejected viewer');
    assert.equal(deletions, beforeInvalidRelease + 1,
      mode + ': invalid viewer must only clean up its own minted token');
  }

  // Take the cleanup baseline after all unsafe viewer cases. A new
  // rejected fixture must not invalidate unrelated page-exit/lease checks.
  const deletesAfterUnsafeViewerCases = deletions;
  const startsAfterUnsafeViewerCases = starts;

  // Reproduce a pagehide event *while* the real browser's session POST is
  // waiting on the local gateway. This keeps the QA tab alive so the late
  // response can resolve; it does not claim navigation-away guarantees for
  // an aborted network request. The returned token must still be released.
  viewerResponseMode = 'valid';
  const viewerGetsBeforeAbandon = viewerRequests;
  const startsBeforeAbandon = starts;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === startsBeforeAbandon + 1,
    'in-flight browser start at pagehide');
  assert.ok(releaseStart, 'synthetic gateway must still be allocating a browser');
  await evaluate('window.dispatchEvent(new Event("pagehide")); true');
  assert.equal(deletions, deletesAfterUnsafeViewerCases, 'pagehide must not delete an as-yet unknown token');
  releaseStart();
  releaseStart = null;
  await until(() => deletions === deletesAfterUnsafeViewerCases + 1,
    'late gateway response must release its newly issued token');
  assert.equal(viewerRequests, viewerGetsBeforeAbandon,
    'abandoned in-flight start must never initiate viewer GET');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'abandoned start must leave iframe cleared');
  assert.equal(await evaluate(
    'state.session === null && state.heartbeat === null && state.countdown === null'
  ), true, 'abandoned start must never arm session-owned timers');
  await evaluate('window.dispatchEvent(new Event("pagehide")); true');
  await sleep(120);
  assert.equal(deletions, deletesAfterUnsafeViewerCases + 1,
    'repeated pagehide after late release must not duplicate teardown');

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
  await until(() => deletions === deletesAfterUnsafeViewerCases + 2,
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
  assert.equal(deletions, deletesAfterUnsafeViewerCases + 2, 'successful lease renewal must not release a session');

  rejectHeartbeat = true;
  await evaluate('window.__qaHeartbeat(); true');
  await until(() => heartbeats === 2, 'rejected real HTTP heartbeat');
  await until(() => deletions === deletesAfterUnsafeViewerCases + 3, 'rejected lease must trigger capacity release');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'),
    true, 'rejected lease must immediately return user to home');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'rejected lease must discard bearer viewer');
  assert.equal(await evaluate(
    'state.session === null && state.heartbeat === null && state.countdown === null'
  ), true, 'rejected lease must clear session and all lease timers');
  rejectHeartbeat = false;
  await sleep(150);
  assert.equal(deletions, deletesAfterUnsafeViewerCases + 3, 'rejected heartbeat must not double-delete');
  assert.equal(deleteAlreadyGone, false,
    '410 heartbeat should be followed by exactly one already-gone DELETE');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'HTTP 404 on expired-lease DELETE must not permanently lock Open');
  assert.equal(await evaluate('document.getElementById("formMessage").textContent'),
    '', 'already-expired session should not show a failed-cleanup warning');

  // Synthetic BFCache transition inside *real Chromium*: exercise the
  // shipped pageshow handler without relying on browser-history heuristics.
  // A previous pagehide already attempted DELETE, so restoring must clear
  // the stale iframe/lease and retry teardown exactly once.
  viewerResponseMode = 'valid';
  const startsBeforeRestore = starts;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === startsBeforeRestore + 1, 'BFCache fixture browser start');
  assert.ok(releaseStart);
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'BFCache synthetic session mounted');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'BFCache synthetic viewer loaded');
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); true');
  await until(() => deletions === deletesAfterUnsafeViewerCases + 4, 'BFCache pagehide keepalive release');
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); true');
  await until(() => deletions === deletesAfterUnsafeViewerCases + 5, 'BFCache pageshow cleanup retry');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'BFCache resume must clear revoked bearer viewer');
  assert.equal(await evaluate(
    'state.session === null && state.heartbeat === null && state.countdown === null'
  ), true, 'BFCache resume must discard old session-owned timers');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'),
    true, 'BFCache restore must return to home');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'BFCache refresh must restore start admission');

  // Browser-native page navigation must trigger the shipped pagehide
  // keepalive DELETE rather than leaving a session alive until TTL. This
  // validates genuine Chromium unload networking, not a VM-simulated event.
  viewerResponseMode = 'valid';
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === startsAfterUnsafeViewerCases + 5, 'valid retry after BFCache teardown');
  assert.equal(deletions, deletesAfterUnsafeViewerCases + 5, 'a pending fresh browser must not double-delete released sessions');
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
  await until(() => deletions === deletesAfterUnsafeViewerCases + 6,
    'real Chromium pagehide sends keepalive session release after navigation');
  await sleep(150);
  assert.equal(deletions, deletesAfterUnsafeViewerCases + 6, 'browser pagehide must release the final browser exactly once');
  assert.equal(starts, startsAfterUnsafeViewerCases + 5, 'only explicitly requested browser attempts should be sent');

  // Drive a *native Chromium history Back*, not a synthetic pageshow event.
  // Chrome may BFCache the previous document or reload it; either way a
  // revoked bearer iframe must not reappear and a fresh session must work.
  const history = await cdp('Page.getNavigationHistory');
  const previousPortal = history.entries.slice(0, history.currentIndex).reverse()
    .find(entry => entry.url === origin + '/');
  assert.ok(previousPortal, 'portal must be present in real browser navigation history');
  await cdp('Page.navigateToHistoryEntry', { entryId: previousPortal.id });
  await sleep(200);
  await until(async () => await evaluate(
    'location.href === ' + JSON.stringify(origin + '/') +
    ' && !!document.getElementById("startButton")'
  ), 'real browser history Back returns to the original TV portal');
  await until(async () => await evaluate(
    'document.getElementById("homeView").hidden === false && ' +
    'document.getElementById("browserView").hidden === true && ' +
    'typeof state !== "undefined" && state.session === null'
  ), 'history return must not restore an abandoned browser token');
  await until(async () => await evaluate(
    'document.getElementById("capacityText").textContent === "Ready to browse" && ' +
    '!document.getElementById("startButton").disabled'
  ), 'real history Back must leave a usable browser-start form');
  assert.notEqual(await evaluate(
    'document.getElementById("browserFrame").getAttribute("src")'
  ), '/s/' + syntheticToken + '/',
  'history restoration may not resurrect the revoked viewer iframe');
  assert.equal(starts, startsAfterUnsafeViewerCases + 5, 'history return must not silently allocate a new browser');
  const afterHistoryDeletions = deletions;
  assert.ok(afterHistoryDeletions >= deletesAfterUnsafeViewerCases + 6 &&
    afterHistoryDeletions <= deletesAfterUnsafeViewerCases + 7,
    'history return may retry the abandoned DELETE only if page is restored from BFCache');

  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === startsAfterUnsafeViewerCases + 6, 'fresh browser start after native history Back');
  assert.ok(releaseStart, 'real history return should use the shipped POST path');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'real history Back must still mount a newly authorized viewer');
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === afterHistoryDeletions + 1,
    'new post-history browser must be releasable through the actual End button');
  assert.equal(starts, startsAfterUnsafeViewerCases + 6, 'no duplicate starts across browser history recovery');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'prior history-recovery End must complete before starting a separate race fixture');

  // A slow DELETE can race a new Open from the returned home form. The
  // gateway may reuse the same-owner token until DELETE finishes, which
  // would revoke the new iframe if the frontend doesn't lock admission.
  const raceBeforeStarts = starts;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === raceBeforeStarts + 1, 'slow-DELETE race session start');
  assert.ok(releaseStart, 'slow-DELETE probe must use real HTTP browser start');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'slow-DELETE probe session mounted in actual Chromium');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'slow-DELETE probe viewer iframe loaded');

  holdNextDelete = true;
  const deleteArrived = new Promise(resolve => { notifyHeldDelete = resolve; });
  await evaluate('document.getElementById("endButton").click(); true');
  await Promise.race([
    deleteArrived,
    sleep(4000).then(() => { throw new Error('held DELETE never reached HTTP fixture'); })
  ]);
  assert.ok(releaseHeldDelete, 'real gateway DELETE must be deliberately held open');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'), true,
    'End should immediately return to home before server acknowledges DELETE');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'while real DELETE is pending, the native Open button must remain disabled');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Finishing previous browser session',
    'real Chromium must immediately display teardown pending before HTTP response');
  assert.equal(await evaluate('document.getElementById("capacityText").parentElement.className'),
    'status', 'held DELETE must never leave a misleading green Ready indicator');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await sleep(120);
  assert.equal(starts, raceBeforeStarts + 1,
    'scripted submit must not race a new browser against a pending DELETE');
  releaseHeldDelete();
  releaseHeldDelete = null;
  notifyHeldDelete = null;
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'completed real HTTP DELETE should restore new start admission');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === raceBeforeStarts + 2,
    'clean browser start after held DELETE completes');
  assert.ok(releaseStart);
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'post-DELETE retry must still mount a viewer');
  await evaluate('document.getElementById("endButton").click(); true');
  await until(async () => await evaluate(
    'document.getElementById("browserView").hidden'
  ), 'post-DELETE retry must still be closable');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'earlier End must settle before a failed-DELETE retry fixture');

  // Actual shipped Chromium fetch() receives HTTP 503 for session DELETE.
  // A healthy capacity poll must not silently unlock same-owner reuse.
  const failedStartBefore = starts;
  const failedDeleteBefore = deletions;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === failedStartBefore + 1, 'failed-DELETE fixture browser start');
  assert.ok(releaseStart, 'failed-DELETE browser must start through real localhost HTTP');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'failed-DELETE fixture browser visible');
  failNextDelete = true;
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === failedDeleteBefore + 1,
    'first real DELETE must reach fixture');
  await until(async () => await evaluate(
    'document.getElementById("formMessage").textContent.includes("Retrying automatically")'
  ), 'HTTP 503 must expose pending cleanup warning');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'failed real DELETE must keep fresh Start disabled');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Finishing previous browser session',
    'healthy gateway health must not mask uncertain teardown');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await sleep(120);
  assert.equal(starts, failedStartBefore + 1,
    'failed teardown must block a second real browser POST');
  // Trigger the existing shipped health poll deterministically rather than
  // sleeping 20 seconds; it must perform the retry over actual HTTP.
  await evaluate('refreshHealth(); true');
  await until(() => deletions === failedDeleteBefore + 2,
    'periodic health refresh must retry failed session DELETE');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'confirmed retry release must unlock browser admission');
  assert.equal(await evaluate('document.getElementById("formMessage").textContent'),
    '', 'confirmed release should clear stale cleanup warning');

  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === failedStartBefore + 2,
    'fresh browser starts after successful retry');
  assert.ok(releaseStart, 'recovered browser must go through real HTTP allocation');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'recovered browser must mount after retry');
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === failedDeleteBefore + 3,
    'recovered browser End must still release its session');

  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'previous successful teardown must finish before transport-drop fixture');

  // A proxy/router can return a fake success (200/202/206), HTTP 404 HTML
  // or unrelated JSON 410 while the real gateway browser is still alive.
  // Only an actual 204 or the reviewed idempotent-gone JSON may unlock Open.
  // Exercise real Chromium fetch and localhost HTTP, not mocked Promises.
  for (const mode of ['json-200', 'html-200', 'json-202', 'json-206',
    'html-404', 'json-body-html-404', 'json-410']) {
    const startBefore = starts;
    const deleteBefore = deletions;
    await evaluate('document.getElementById("browserForm").requestSubmit(); true');
    await until(() => starts === startBefore + 1,
      mode + ': browser must be started over real localhost HTTP');
    assert.ok(releaseStart, mode + ': fixture must hold the local start');
    releaseStart();
    releaseStart = null;
    await until(async () => await evaluate(
      '!document.getElementById("browserView").hidden'
    ), mode + ': browser viewer must mount before teardown');
    nextDeleteProxyError = mode;
    await evaluate('document.getElementById("endButton").click(); true');
    await until(() => deletions === deleteBefore + 1,
      mode + ': actual DELETE reaches local proxy-error fixture');
    await until(async () => await evaluate(
      'document.getElementById("formMessage").textContent.includes("Retrying automatically")'
    ), mode + ': untrusted response must show pending release');
    assert.equal(await evaluate('document.getElementById("browserView").hidden'), true,
      mode + ': viewer must unmount despite uncertain release');
    assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
      'about:blank', mode + ': bearer iframe must be discarded');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
      mode + ': generic proxy status must not unlock Open');
    await evaluate('document.getElementById("browserForm").requestSubmit(); true');
    await sleep(100);
    assert.equal(starts, startBefore + 1,
      mode + ': no second gateway browser while cleanup is unconfirmed');
    await evaluate('refreshHealth(); true');
    await until(() => deletions === deleteBefore + 2,
      mode + ': normal health poll must retry DELETE after proxy error');
    await until(async () => await evaluate(
      '!document.getElementById("startButton").disabled'
    ), mode + ': successful actual HTTP retry restores Open');
    assert.equal(await evaluate('document.getElementById("formMessage").textContent'), '',
      mode + ': confirmed cleanup clears warning');
  }

  // The browser should also fail closed if the connection is cut *without*
  // any HTTP error response at all. This exercises a genuine broken TCP
  // connection during DELETE, not an HTTP 503 or a synthetic rejected Promise.
  const droppedStartBefore = starts;
  const droppedDeleteBefore = deletions;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === droppedStartBefore + 1,
    'socket-drop browser starts through real HTTP POST');
  assert.ok(releaseStart);
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'socket-drop fixture must mount real Chromium iframe');

  droppedDeleteAttemptsRemaining = 4;
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions >= droppedDeleteBefore + 1,
    'deliberately dropped DELETE must reach the loopback TCP server');
  await until(async () => await evaluate(
    'document.getElementById("formMessage").textContent.includes("Retrying automatically")'
  ), 'connection reset must be treated as unconfirmed teardown');
  const failedNetworkDeletes = deletions - droppedDeleteBefore;
  assert.ok(failedNetworkDeletes >= 1 && failedNetworkDeletes <= 4,
    'Chrome may replay idempotent DELETE but all automatic attempts must remain within fixture budget');
  droppedDeleteAttemptsRemaining = 0; // allow the explicit health-poll retry
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'browser must not reuse a possibly live bearer after transport drop');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await sleep(100);
  assert.equal(starts, droppedStartBefore + 1,
    'form submit may not start a browser while lost DELETE is unreconciled');

  await evaluate('refreshHealth(); true');
  await until(() => deletions === droppedDeleteBefore + failedNetworkDeletes + 1,
    'real Chromium must retry dropped DELETE via health poll');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'completed recovery must restore browser start');
  assert.equal(await evaluate('document.getElementById("formMessage").textContent'),
    '', 'successful retry must clear failure warning');

  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === droppedStartBefore + 2,
    'new Chrome browser start works after dropped-DELETE reconciliation');
  assert.ok(releaseStart);
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'post-reconciliation viewer must still be mountable');
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === droppedDeleteBefore + failedNetworkDeletes + 2,
    'new browser after socket drop must still end normally');

  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'previous End must finish before late-start release-failure fixture');

  // A POST response can arrive after synthetic pagehide and BFCache restore:
  // the viewer must never mount, and a failed 503 cleanup must retain its
  // release token until the existing periodic health refresh retries it.
  const lateFailStartsBefore = starts;
  const lateFailDeletesBefore = deletions;
  const lateFailViewersBefore = viewerRequests;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === lateFailStartsBefore + 1,
    'late-start cleanup failure fixture begins real browser POST');
  assert.ok(releaseStart, 'browser launch must remain pending during pagehide');
  await evaluate('window.dispatchEvent(new Event("pagehide")); true');
  assert.equal(deletions, lateFailDeletesBefore,
    'pagehide cannot delete a browser whose token is still pending');
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); true');
  failNextDelete = true;
  releaseStart();
  releaseStart = null;
  await until(() => deletions === lateFailDeletesBefore + 1,
    'abandoned late POST must send cleanup DELETE through real HTTP');
  await until(async () => await evaluate(
    'document.getElementById("formMessage").textContent.includes("Retrying automatically")'
  ), 'failed late HTTP DELETE must report pending retry on BFCache-restored page');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'BFCache restoration cannot reopen a still-live late session');
  assert.equal(viewerRequests, lateFailViewersBefore,
    'late browser token must never reach the real Chromium iframe');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Finishing previous browser session');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await sleep(100);
  assert.equal(starts, lateFailStartsBefore + 1,
    'new start must be blocked until failed late release is reconciled');
  await evaluate('refreshHealth(); true');
  await until(() => deletions === lateFailDeletesBefore + 2,
    'health poll must retry the abandoned issued token');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'successful late token cleanup must restore start admission');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === lateFailStartsBefore + 2,
    'new browser POST succeeds after late failed cleanup recovery');
  assert.ok(releaseStart);
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'recovered browser should mount normally');
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === lateFailDeletesBefore + 3,
    'post-reconciliation viewer must remain closable');

  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'prior End must finish before malformed-response cleanup-failure fixture');

  // A compromised same-origin response may mint a valid bearer but return
  // an unsafe external viewer URL. The browser must DELETE that token; when
  // the real localhost gateway returns 503, its next POST must remain
  // blocked until the established health-poll retry confirms teardown.
  const invalidDeleteBefore = deletions;
  const invalidStartBefore = starts;
  const invalidViewerBefore = viewerRequests;
  viewerResponseMode = 'external';
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === invalidStartBefore + 1,
    'unsafe-viewer response must start through local HTTP POST');
  assert.ok(releaseStart, 'unsafe-viewer fixture must hold the gateway response');
  failNextDelete = true;
  releaseStart();
  releaseStart = null;
  await until(() => deletions === invalidDeleteBefore + 1,
    'rejected viewer must attempt actual HTTP DELETE of minted token');
  await until(async () => await evaluate(
    'document.getElementById("formMessage").textContent.includes("Retrying automatically")'
  ), 'failed cleanup of unsafe viewer must have visible retry feedback');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'invalid viewer plus failed DELETE must prohibit another start');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Finishing previous browser session',
    'invalid response cleanup must never misleadingly report Ready');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'), true,
    'unsafe minted viewer must never mount its iframe');
  assert.equal(viewerRequests, invalidViewerBefore,
    'unsafe viewer URL may not even cause a synthetic iframe GET');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await sleep(100);
  assert.equal(starts, invalidStartBefore + 1,
    'scripted submit cannot reuse minted token after failed cleanup');

  viewerResponseMode = 'valid';
  await evaluate('refreshHealth(); true');
  await until(() => deletions === invalidDeleteBefore + 2,
    'health poll must retry failed cleanup of rejected viewer token');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'successful retry must reopen normal Start flow');
  assert.equal(await evaluate('document.getElementById("formMessage").textContent'), '',
    'successful cleanup must clear retry warning');

  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === invalidStartBefore + 2,
    'fresh viewer can start after malformed-response cleanup recovery');
  assert.ok(releaseStart);
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'fresh valid browser mounts after release of unsafe minted token');

  // Real TV exit while fullscreen: pressing Space on the fullscreen toolbar
  // control must enter browser fullscreen, native Tab must reach End session,
  // and Space must release the minted viewer before leaving fullscreen.
  const beforeFullscreenEndStarts = starts;
  // Enter fullscreen at an actual narrow viewport, not merely desktop size.
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 568, deviceScaleFactor: 1, mobile: false
  });
  assert.equal(await evaluate('window.innerWidth'), 320,
    'the actual fullscreen acceptance must run at a 320px viewport');
  assert.equal(await evaluate(`(() => {
    const button = document.getElementById('fullscreenButton');
    button.focus();
    return document.activeElement === button;
  })()`), true, 'fullscreen button must accept keyboard focus before native Space');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32
    });
  }
  await until(async () => await evaluate(
    'document.fullscreenElement?.id === "browserView"'
  ), 'native Space must fullscreen the TV browser with its End control');
  assert.equal(await evaluate(`(() => {
    const end = document.getElementById('endButton');
    const box = end.getBoundingClientRect();
    return document.fullscreenElement.contains(end) &&
      document.elementFromPoint(box.left + box.width / 2,
        box.top + box.height / 2) === end;
  })()`), true, 'real fullscreen must preserve a visually hit-testable End control');
  const narrowControls = await evaluate('(() => {' +
    'const toolbar = document.querySelector(".browser-toolbar");' +
    'return {viewport: window.innerWidth, scroll: toolbar.scrollWidth, width: toolbar.clientWidth,' +
    'buttons: ["fullscreenButton","endButton"].map(id => {' +
    'const b = document.getElementById(id), r = b.getBoundingClientRect();' +
    'return {id, left:r.left, right:r.right,' +
    'hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b};' +
    '})};})()');
  assert.equal(narrowControls.viewport, 320);
  assert.ok(narrowControls.scroll <= narrowControls.width + 1,
    'real 320px fullscreen must not clip the toolbar');
  for (const control of narrowControls.buttons) {
    assert.ok(control.left >= 0 && control.right <= 321 && control.hit,
      'real 320px fullscreen must retain operable ' + control.id +
        ': ' + JSON.stringify(control));
  }
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: 'Tab', code: 'Tab',
      windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9
    });
  }
  assert.equal(await evaluate('document.activeElement?.id'), 'endButton',
    'native TV Tab must focus End session inside fullscreen');
  await evaluate(`(() => {
    const end = document.getElementById('endButton');
    end.addEventListener('click', event => {
      window.__qaNativeFullscreenEnd = event.isTrusted;
    }, { once: true });
  })(); true`);
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32
    });
  }
  await until(() => deletions === invalidDeleteBefore + 3,
    'native fullscreen End must release browser through real localhost DELETE');
  assert.equal(await evaluate('window.__qaNativeFullscreenEnd'), true,
    'fullscreen exit must be triggered by a real trusted keyboard click');
  await until(async () => await evaluate(
    'document.fullscreenElement === null && document.getElementById("browserView").hidden'
  ), 'native fullscreen End must exit fullscreen and discard the viewer');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'native fullscreen End must remove the bearer iframe');
  assert.equal(starts, beforeFullscreenEndStarts,
    'fullscreen teardown must not allocate another browser session');
  await cdp('Emulation.clearDeviceMetricsOverride');

  // A live health API response cannot certify readiness if the curated
  // /api/sites endpoint is offline or sends untrusted credentials. Reopen the
  // ACTUAL bundled portal in Chrome for every case (not a VM DOM fake) and
  // verify the page itself cannot issue a new browser POST.
  const beforeCatalogueProbes = starts;
  for (const mode of ['offline', 'userinfo', 'empty',
    'many', 'long-name', 'long-url', 'bidi-name',
    'c1-label', 'arabic-mark-label', 'rtl-mark-label', 'paragraph-separator-label',
    'zero-width-label', 'soft-hyphen-label', 'word-joiner-label', 'bom-label',
    'duplicate-label', 'casefold-label', 'fullwidth-label']) {
    sitesMode = mode;
    await cdp('Page.navigate', { url: origin + '/?catalogue=' + mode });
    await until(async () => await evaluate(
      'document.readyState === "complete" && ' +
      'document.getElementById("capacityText")?.textContent === "Site catalogue unavailable"'
    ), 'real Chromium must show unavailable catalogue: ' + mode);
    assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
      mode + ': healthy gateway must not unlock browser start without a valid catalogue');
    assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'), 0,
      mode + ': unsafe site suggestions may not reach the real browser DOM');
    assert.equal(await evaluate('document.getElementById("urlInput").value'), '',
      mode + ': a browser should not prefill an unreviewed site');
    assert.equal(await evaluate('document.getElementById("formMessage").textContent.includes("Reload to retry")'),
      true, mode + ': TV user must see a usable retry message');
    await evaluate(`(() => {
      const input = document.getElementById('urlInput');
      input.value = 'https://fawesome.tv/';
      return document.getElementById('browserForm').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    })()`);
    await sleep(100);
    assert.equal(starts, beforeCatalogueProbes,
      mode + ': scripted submit must not allocate a browser when sites are unavailable');
  }
  sitesMode = 'ready';
  await cdp('Page.navigate', { url: origin + '/?catalogue=restored' });
  await until(async () => await evaluate(
    'document.readyState === "complete" && ' +
    'document.getElementById("capacityText")?.textContent === "Ready to browse"'
  ), 'real Chromium must regain valid catalogue readiness on reload');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'verified catalogue must restore normal Open-button admission');
  assert.equal(await evaluate('document.getElementById("urlInput").value'), approvedStart,
    'restored portal must again prefill its actual reviewed start URL');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
    sites.length, 'restored real browser must show every curated site');

  // Real browser acceptance of the TV URL gate: input type=url alone
  // cannot reject credential-bearing HTTPS or a deceptive reviewed-origin
  // prefix, and scripts can bypass native form validity entirely.
  const beforeRejectedManualStarts = starts;
  const invalidManualInputs = [
    ['credentials', 'https://viewer:password@fawesome.tv/watch'],
    ['encoded-credentials', 'https://us%65r@fawesome.tv/watch'],
    ['deceptive authority', 'https://fawesome.tv@outside.invalid/watch'],
    ['lookalike suffix', 'https://fawesome.tv.outside.invalid/watch'],
    ['non-HTTPS', 'http://fawesome.tv/watch']
  ];
  for (const [label, url] of invalidManualInputs) {
    await evaluate(`(() => {
      const input = document.getElementById('urlInput');
      input.value = ${JSON.stringify(url)};
      return document.getElementById('browserForm').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    })()`);
    assert.equal(await evaluate(
      'document.getElementById("formMessage").textContent.includes("approved HTTPS website without credentials")'),
      true, label + ': real Chrome must show reviewed URL admission feedback');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
      label + ': rejected manual URL must not lock legitimate future navigation');
    await sleep(75);
    assert.equal(starts, beforeRejectedManualStarts,
      label + ': real browser must not POST an unreviewed or credential-bearing start URL');
  }
  assert.equal(await evaluate('document.getElementById("browserView").hidden'), true,
    'rejected manual URLs must never mount an authenticated viewer');
  const rejectedFrameSource = await evaluate(
    'document.getElementById("browserFrame").getAttribute("src")');
  assert.ok(rejectedFrameSource === null || rejectedFrameSource === 'about:blank',
    'rejected manual URL must never assign a bearer-bearing iframe');
  await evaluate(`(() => {
    const input = document.getElementById('urlInput');
    input.value = ${JSON.stringify(approvedStart)};
    return true;
  })()`);
  assert.equal(await evaluate('document.getElementById("urlInput").value'), approvedStart,
    'real browser still accepts its reviewed input after invalid attempts');

  // After a transient /api/sites 503, the shipped portal's regular health
  // callback must re-fetch the catalogue and recover WITHOUT a page reload.
  // Call the same refreshHealth function registered with the 20-second timer,
  // avoiding a wall-clock wait while still executing real Chrome fetch/DOM.
  const beforeAutoCatalogueRecovery = starts;
  sitesMode = 'offline';
  await cdp('Page.navigate', { url: origin + '/?catalogue=transient' });
  await until(async () => await evaluate(
    'document.readyState === "complete" && ' +
    'document.getElementById("capacityText")?.textContent === "Site catalogue unavailable"'
  ), 'actual TV must show transient catalogue outage');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'transient site API failure may not permit a browser start');
  sitesMode = 'ready';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Ready to browse', 'TV health callback must restore catalogue readiness without reload');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'verified catalogue recovery must re-enable Open in the same loaded page');
  assert.equal(await evaluate('document.querySelectorAll("#siteSuggestions option").length'),
    sites.length, 'TV must refill reviewed suggestions after transient outage');
  assert.equal(await evaluate('document.getElementById("urlInput").value'), approvedStart,
    'recovered TV must prefill the genuine reviewed start URL');
  assert.equal(await evaluate('document.getElementById("formMessage").textContent'), '',
    'successful recovery must clear old failure guidance');
  assert.equal(starts, beforeAutoCatalogueRecovery,
    'recovering the catalogue is read-only and must not start a browser');

  // Native Chromium acceptance of the bounded 7-second READ-only requests:
  // one local HTTP socket deliberately never returns an API response. Chrome
  // itself must abort it and fail closed, then recover on the next healthy
  // response without any viewer session POST.
  const beforeStalledReadStarts = starts;
  health = 'hang-once';
  await evaluate('refreshHealth(); true');
  await until(async () => await evaluate(
    'document.getElementById("capacityText").textContent === "Browser engine offline"'
  ), 'real Chrome must abort hung readiness GET', 230);
  assert.equal(stalledHealthGets, 1,
    'native browser must actually reach the hanging local health endpoint');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'timed-out native health request must revoke stale ready admission');
  assert.equal(starts, beforeStalledReadStarts,
    'hung health cannot allocate a viewer browser');
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Ready to browse', 'healthy native GET must recover after aborted health');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false);

  sitesMode = 'hang-once';
  await cdp('Page.navigate', { url: origin + '/?catalogue=stalled-first-response' });
  await until(async () => await evaluate(
    'document.readyState === "complete" && ' +
    'document.getElementById("capacityText")?.textContent === "Ready to browse"'
  ), 'real Chrome must abort hung catalogue and restore normal bootstrap', 240);
  assert.equal(stalledSiteGets, 1,
    'actual browser must exercise a stuck local curated-site HTTP request');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'verified site retry and health must restore Open after aborted catalogue');
  assert.equal(await evaluate('document.getElementById("urlInput").value'), approvedStart);
  assert.equal(starts, beforeStalledReadStarts,
    'aborting either read endpoint must not send a remote browser start');

  // Unlike the earlier pre-header hang, a proxy can supply perfectly valid
  // HTTP 200/JSON headers and ONE body chunk, then stop forever. Exercise the
  // actual Chrome ReadableStream path protected by the shared 7s abort signal.
  const beforeStalledBodyStarts = starts;
  health = 'hang-body-once';
  await evaluate('refreshHealth(); true');
  await until(async () => await evaluate(
    'document.getElementById("capacityText").textContent === "Browser engine offline"'
  ), 'real Chrome must abort stalled health body after HTTP 200', 230);
  assert.equal(stalledHealthBodies, 1,
    'real browser must consume an actual partially streamed health response');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'stalled health body cannot keep old capacity as available');
  assert.equal(starts, beforeStalledBodyStarts,
    'post-header stalled health must not allocate viewer sessions');
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Ready to browse', 'real Chrome must recover after stalled health body');

  sitesMode = 'hang-body-once';
  await cdp('Page.navigate', { url: origin + '/?catalogue=postheader-stalled-json' });
  await until(async () => await evaluate(
    'document.readyState === "complete" && ' +
    'document.getElementById("capacityText")?.textContent === "Ready to browse"'
  ), 'real Chrome must recover from stalled streamed catalogue after 200', 240);
  assert.equal(stalledSiteBodies, 1,
    'real browser must consume an actual partially streamed catalogue response');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
    'valid re-fetched site catalogue must restore Open after body timeout');
  assert.equal(starts, beforeStalledBodyStarts,
    'post-header stalled catalogue cannot allocate viewer sessions');

  // Native Chromium proof for the bounded foreground DELETE: an actual
  // localhost HTTP request can hang forever while the UI must still reclaim
  // its retry state without accepting a second browser session.
  const beforeDeleteTimeoutStarts = starts;
  const beforeDeleteTimeoutCount = deletions;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === beforeDeleteTimeoutStarts + 1,
    'real browser start for hanging-DELETE acceptance');
  assert.ok(releaseStart, 'local browser start must wait for fixture release');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'real Chrome must mount viewer before DELETE timeout scenario');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'local viewer must fully load before attempting teardown');
  holdNextDelete = true;
  const heldDeleteArrived = new Promise(resolve => { notifyHeldDelete = resolve; });
  await evaluate('document.getElementById("endButton").click(); true');
  await Promise.race([heldDeleteArrived,
    sleep(4000).then(() => { throw new Error('timed-out DELETE never reached fixture'); })]);
  assert.equal(deletions, beforeDeleteTimeoutCount + 1,
    'native End must send one intentionally hanging DELETE');
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'a stuck DELETE must keep browser admission locked');
  await until(async () => await evaluate(
    'document.getElementById("formMessage").textContent.includes("Retrying automatically")'
  ), 'real Chrome must time out dangling DELETE and show retry feedback', 240);
  assert.equal(await evaluate('document.getElementById("startButton").disabled'), true,
    'DELETE abort must never claim confirmed browser removal');
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await sleep(130);
  assert.equal(starts, beforeDeleteTimeoutStarts + 1,
    'timed-out foreground release must not allow another browser POST');
  releaseHeldDelete?.();
  releaseHeldDelete = null;
  notifyHeldDelete = null;
  await evaluate('refreshHealth()');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'confirmed retry of original DELETE must unlock new session admission');
  assert.equal(deletions, beforeDeleteTimeoutCount + 2,
    'after the timeout, exactly one health-tick retry must release the same token');
  assert.equal(await evaluate('document.getElementById("formMessage").textContent'), '',
    'confirmed real HTTP teardown must clear retry feedback');

  // Keep a viewer mounted while a *real* localhost heartbeat POST never
  // responds. The shipped app must use its own AbortSignal deadline to tear
  // down the uncertain session, not leave a live frame or runaway timers.
  await evaluate(`(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 30000) window.__qaHeartbeat = callback;
      return original(callback, delay, ...args);
    };
    return true;
  })()`);
  const startsBeforeHeartbeatTimeout = starts;
  const deletionsBeforeHeartbeatTimeout = deletions;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === startsBeforeHeartbeatTimeout + 1,
    'native heartbeat timeout fixture must start a synthetic browser');
  assert.ok(releaseStart, 'native heartbeat fixture must control browser POST response');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'browser must mount before interrupted lease renewal');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'native heartbeat fixture viewer should load');
  assert.equal(await evaluate('typeof window.__qaHeartbeat'), 'function',
    'native TV must register a real heartbeat interval');
  hangNextHeartbeat = true;
  await evaluate('window.__qaHeartbeat(); true');
  await until(() => hungHeartbeatCalls === 1,
    'real Chrome heartbeat must reach the intentionally stalled HTTP endpoint');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'), false,
    'hung but not-yet-timed-out heartbeat must not close viewer prematurely');
  await until(async () => await evaluate(
    'document.getElementById("browserView").hidden && ' +
    'document.getElementById("browserFrame").getAttribute("src") === "about:blank"'
  ), '10-second real-browser heartbeat timeout must discard viewer', 270);
  await until(() => deletions === deletionsBeforeHeartbeatTimeout + 1,
    'heartbeat timeout must dispatch one idempotent session DELETE');
  assert.equal(starts, startsBeforeHeartbeatTimeout + 1,
    'heartbeat failure must not trigger a second gateway browser start');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'confirmed cleanup after timed-out heartbeat must restore normal start');

  // Browser-real guard against false successful lease renewals. All three
  // responses succeed at the HTTP transport layer, but none confirms a
  // usable viewer session. Exercise the actual app.js heartbeat interval,
  // loopback fetch, viewer unmount and one DELETE per invalid reply.
  for (const [label, reply] of [
    ['html-typed-valid-json', { status: 200, mediaType: 'text/html',
      body: { ok: true, expiresAt: Date.now() + 900_000 } }],
    ['accepted-202-but-not-renewed', { status: 202,
      body: { ok: true, expiresAt: Date.now() + 900_000 } }],
    ['partial-206-not-authoritative', { status: 206,
      body: { ok: true, expiresAt: Date.now() + 900_000 } }],
    ['no-content', { status: 204 }],
    ['negative-json', { status: 200, body: { ok: false, expiresAt: Date.now() + 900_000 } }],
    ['expired-json', { status: 200, body: { ok: true, expiresAt: Date.now() - 1000 } }]
  ]) {
    const startBefore = starts;
    const deleteBefore = deletions;
    await evaluate('document.getElementById("browserForm").requestSubmit(); true');
    await until(() => starts === startBefore + 1,
      label + ': start new synthetic browser through localhost POST');
    assert.ok(releaseStart, label + ': test fixture should hold browser start');
    releaseStart();
    releaseStart = null;
    await until(async () => await evaluate(
      '!document.getElementById("browserView").hidden'
    ), label + ': real viewer must mount before heartbeat');
    await until(async () => await evaluate(
      'document.getElementById("browserLoading").hidden'
    ), label + ': viewer must finish loading');
    assert.equal(await evaluate('typeof window.__qaHeartbeat'), 'function',
      label + ': test must invoke actual registered heartbeat callback');
    nextHeartbeatReply = reply;
    await evaluate('window.__qaHeartbeat(); true');
    await until(async () => await evaluate(
      'document.getElementById("browserView").hidden && ' +
      'document.getElementById("browserFrame").getAttribute("src") === "about:blank"'
    ), label + ': successful HTTP with invalid lease must drop iframe');
    await until(() => deletions === deleteBefore + 1,
      label + ': invalid lease must send one cleanup DELETE');
    assert.equal(starts, startBefore + 1,
      label + ': invalid renewal must not create another browser');
    await until(async () => await evaluate(
      '!document.getElementById("startButton").disabled'
    ), label + ': completed genuine cleanup permits deliberate retry');
  }

  // A valid heartbeat can shorten the hard session deadline. The shipped
  // browser's one-second countdown must honor it without another 30-second
  // heartbeat or a reload. Exercise real Chromium / localhost HTTP.
  const startsBeforeShortLease = starts;
  const deletesBeforeShortLease = deletions;
  const beatsBeforeShortLease = heartbeats;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === startsBeforeShortLease + 1,
    'shortened-lease acceptance must create one local browser');
  assert.ok(releaseStart, 'shortened-lease start response must be controlled');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'shortened-lease browser must mount');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'shortened-lease viewer must fully load');
  nextHeartbeatReply = {
    status: 200,
    body: { ok: true, expiresAt: Date.now() + 1900 }
  };
  await evaluate('window.__qaHeartbeat(); true');
  await until(() => heartbeats === beatsBeforeShortLease + 1,
    'shorter lease must be acknowledged over local HTTP');
  await until(async () => await evaluate(
    'document.getElementById("timer").textContent.startsWith("00:0")'
  ), 'real TV must display shorter lease countdown immediately');
  await until(async () => await evaluate(
    'document.getElementById("browserView").hidden && ' +
    'document.getElementById("browserFrame").getAttribute("src") === "about:blank"'
  ), 'real one-second countdown must close shorter lease promptly', 140);
  await until(() => deletions === deletesBeforeShortLease + 1,
    'expired shortened browser must dispatch one session DELETE');
  assert.equal(starts, startsBeforeShortLease + 1,
    'countdown expiry cannot create a second browser');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'successful shortened-lease cleanup must restore manual Open');

  // Real Chrome/loopback: a proxy that mislabels an otherwise valid 201
  // browser-start JSON must not mount the bearer iframe. Because the gateway
  // may already have minted that token, the real UI must still issue a
  // canonical DELETE before restoring admission.
  for (const mediaType of ['text/html', 'missing', 'application/problem+json']) {
    const startsBefore = starts;
    const viewersBefore = viewerRequests;
    const deletesBefore = deletions;
    nextStartMediaType = mediaType;
    await evaluate('document.getElementById("browserForm").requestSubmit(); true');
    await until(() => starts === startsBefore + 1,
      mediaType + ': real browser start should reach local fixture');
    assert.ok(releaseStart, mediaType + ': fixture must control browser creation');
    releaseStart();
    releaseStart = null;
    await until(() => deletions === deletesBefore + 1,
      mediaType + ': invalid successful reply must still release the minted token');
    await until(async () => await evaluate(
      'document.getElementById("formMessage").textContent === "Invalid browser session response."'
    ), mediaType + ': rejected response must show safe message');
    assert.equal(viewerRequests, viewersBefore,
      mediaType + ': no actual authenticated iframe GET for untrusted media type');
    assert.equal(await evaluate('document.getElementById("browserView").hidden'), true,
      mediaType + ': no viewer mounted');
    assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
      'about:blank', mediaType + ': old bearer iframe must remain cleared');
    assert.equal(starts, startsBefore + 1,
      mediaType + ': no hidden second browser start');
    await until(async () => await evaluate(
      '!document.getElementById("startButton").disabled'
    ), mediaType + ': confirmed cleanup permits retry');
  }

  // Actual Chromium / localhost acceptance for unexpected successful
  // POST statuses, distinct from malformed Content-Type. These responses
  // deliberately contain fully valid bearer JSON to show why accepting
  // arbitrary 2xx would mount an unconfirmed viewer. The same-owner 200
  // reuse status remains supported; new sessions use 201 by default.
  for (const status of [202, 203, 206]) {
    const priorStarts = starts;
    const priorDeletions = deletions;
    const priorViewers = viewerRequests;
    nextStartStatus = status;
    await evaluate('document.getElementById("browserForm").requestSubmit(); true');
    await until(() => starts === priorStarts + 1,
      status + ': unexpected status fixture must receive real browser POST');
    assert.ok(releaseStart, status + ': fixture must control the 2xx response');
    releaseStart();
    releaseStart = null;
    await until(() => deletions === priorDeletions + 1,
      status + ': rejected but minted bearer must be DELETEd');
    await until(async () => await evaluate(
      'document.getElementById("formMessage").textContent === "Invalid browser session response."'
    ), status + ': user sees reviewed error for unexpected status');
    assert.equal(viewerRequests, priorViewers,
      status + ': unreviewed 2xx must not fetch authenticated iframe URL');
    assert.equal(await evaluate('document.getElementById("browserView").hidden'), true,
      status + ': unreviewed 2xx must leave viewer hidden');
    assert.equal(starts, priorStarts + 1,
      status + ': invalid response must never start a replacement implicitly');
    await until(async () => await evaluate(
      '!document.getElementById("startButton").disabled'
    ), status + ': confirmed DELETE must restore deliberate retry');
  }

  // Explicitly accept the gateway's 200 OK same-owner reuse contract.
  const beforeReuseStart = starts;
  const beforeReuseDelete = deletions;
  nextStartStatus = 200;
  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === beforeReuseStart + 1,
    'real 200 reuse must reach local browser fixture');
  assert.ok(releaseStart, 'real reuse fixture must hold start');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'HTTP 200 reuse with valid body must mount viewer');
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === beforeReuseDelete + 1,
    'reused viewer must still send idempotent cleanup');
  await until(async () => await evaluate(
    '!document.getElementById("startButton").disabled'
  ), 'reused viewer must return to ready home after successful DELETE');

  // Real Chromium must never render raw error JSON from a failed browser
  // POST. A reverse proxy might echo a bearer route or credentials into its
  // failure body; only intentionally reviewed status-based guidance is safe.
  const forgedBearer = '/s/' + syntheticToken + '/?secret=fixture';
  for (const [status, expected] of [
    [502, 'Could not start browser. Try again.'],
    [503, 'Browser engine unavailable. Try again shortly.'],
    [409, 'Browser currently in use. Try again shortly.']
  ]) {
    const beforeUnsafeStart = starts;
    const beforeUnsafeViewer = viewerRequests;
    nextStartFailure = {
      status,
      error: 'Proxy diagnostic for ' + forgedBearer +
        ' https://user:password@upstream.invalid/login' + 'x'.repeat(80000)
    };
    await evaluate('document.getElementById("browserForm").requestSubmit(); true');
    await until(() => starts === beforeUnsafeStart + 1,
      status + ': real POST must reach the local upstream-error fixture');
    await until(async () => await evaluate(
      'document.getElementById("formMessage").textContent === ' + JSON.stringify(expected)
    ), status + ': native TV must render only the reviewed safe error');
    assert.equal(await evaluate('document.getElementById("formMessage").textContent.includes("password")'),
      false, status + ': proxy URL credentials must not appear in UI');
    assert.equal(await evaluate('document.getElementById("formMessage").textContent.includes(' +
      JSON.stringify(forgedBearer) + ')'), false,
      status + ': proxy-issued bearer-like path must not appear in UI');
    assert.equal(viewerRequests, beforeUnsafeViewer,
      status + ': rejected browser must not load a viewer');
    assert.equal(await evaluate('document.getElementById("browserView").hidden'), true,
      status + ': failed POST may not show a viewer');
    assert.equal(await evaluate('document.getElementById("startButton").disabled'), false,
      status + ': failed POST should permit deliberate later retry');
  }

  assert.equal(fixtureError, null, 'local fixture must not encounter unhandled errors');
  console.log('Real Chromium shipped TV portal acceptance passed: available/busy/offline/' +
    'draining/malformed health, blocked native Enter/pointer while unavailable, recovery, guarded starts, authenticated local iframe,' +
    ' completed load, native keyboard start/Escape/End, manual teardown, browser-native pagehide keepalive DELETE,' +
    ' pending-unload cleanup, BFCache restore, native Back recovery, failed DELETE retry, transport-drop recovery, heartbeat 410/DELETE 404 recovery, failed late-start cleanup and BFCache reconciliation, invalid viewer failed-DELETE reconciliation, native fullscreen Tab/Space End, no duplicate release');
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
