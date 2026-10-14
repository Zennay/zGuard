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
let starts = 0;
let viewerResponseMode = 'valid';
let deletions = 0;
let failNextDelete = false;
let droppedDeleteAttemptsRemaining = 0;
let holdNextDelete = false;
let releaseHeldDelete = null;
let notifyHeldDelete = null;
let viewerRequests = 0;
let heartbeats = 0;
let rejectHeartbeat = false;
let deleteAlreadyGone = false;
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
      if (rejectHeartbeat) {
        // Shipped gateway rejects DELETE with 404 after lease expiry.
        // A second DELETE cannot make an already expired token more dead.
        deleteAlreadyGone = true;
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

  health = 'busy';
  await evaluate('refreshHealth()');
  assert.equal(await evaluate('document.getElementById("capacityText").textContent'),
    'Browser currently in use', 'browser-full status should not look ready');
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
  assert.equal(await evaluate('new URL(document.getElementById("browserFrame").src).pathname'),
    '/s/' + syntheticToken + '/', 'viewer iframe must mount only the issued bearer path');
  await until(async () => await evaluate(
    'document.getElementById("browserLoading").hidden'
  ), 'viewer loading indicator clears after local iframe load');

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
  const unsafeViewerModes = ['external', 'javascript', 'mismatched-token'];
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
  assert.equal(deletions, 4, 'pagehide must not delete an as-yet unknown token');
  releaseStart();
  releaseStart = null;
  await until(() => deletions === 5,
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
  assert.equal(deletions, 5,
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
  await until(() => deletions === 6,
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
  assert.equal(deletions, 6, 'successful lease renewal must not release a session');

  rejectHeartbeat = true;
  await evaluate('window.__qaHeartbeat(); true');
  await until(() => heartbeats === 2, 'rejected real HTTP heartbeat');
  await until(() => deletions === 7, 'rejected lease must trigger capacity release');
  assert.equal(await evaluate('document.getElementById("browserView").hidden'),
    true, 'rejected lease must immediately return user to home');
  assert.equal(await evaluate('document.getElementById("browserFrame").getAttribute("src")'),
    'about:blank', 'rejected lease must discard bearer viewer');
  assert.equal(await evaluate(
    'state.session === null && state.heartbeat === null && state.countdown === null'
  ), true, 'rejected lease must clear session and all lease timers');
  rejectHeartbeat = false;
  await sleep(150);
  assert.equal(deletions, 7, 'rejected heartbeat must not double-delete');
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
  await until(() => deletions === 8, 'BFCache pagehide keepalive release');
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); true');
  await until(() => deletions === 9, 'BFCache pageshow cleanup retry');
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
  await until(() => starts === 9, 'valid retry after BFCache teardown');
  assert.equal(deletions, 9, 'a pending fresh browser must not double-delete released sessions');
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
  await until(() => deletions === 10,
    'real Chromium pagehide sends keepalive session release after navigation');
  await sleep(150);
  assert.equal(deletions, 10, 'browser pagehide must release the final browser exactly once');
  assert.equal(starts, 9, 'only explicitly requested browser attempts should be sent');

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
  assert.equal(starts, 9, 'history return must not silently allocate a new browser');
  const afterHistoryDeletions = deletions;
  assert.ok(afterHistoryDeletions >= 10 && afterHistoryDeletions <= 11,
    'history return may retry the abandoned DELETE only if page is restored from BFCache');

  await evaluate('document.getElementById("browserForm").requestSubmit(); true');
  await until(() => starts === 10, 'fresh browser start after native history Back');
  assert.ok(releaseStart, 'real history return should use the shipped POST path');
  releaseStart();
  releaseStart = null;
  await until(async () => await evaluate(
    '!document.getElementById("browserView").hidden'
  ), 'real history Back must still mount a newly authorized viewer');
  await evaluate('document.getElementById("endButton").click(); true');
  await until(() => deletions === afterHistoryDeletions + 1,
    'new post-history browser must be releasable through the actual End button');
  assert.equal(starts, 10, 'no duplicate starts across browser history recovery');
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
