// Real headless Chromium runs the shipped MV3 extension, not a VM mock.
// This test deliberately does not claim to prove MAIN-world window.open
// interception until invoked with --require-mainworld.
// --cold-start intentionally reproduces the kiosk CLI navigation race (#302).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireMainWorld = process.argv.includes('--require-mainworld');
const requireAuxclick = process.argv.includes('--require-auxclick');
const coldStart = process.argv.includes('--cold-start');
const variants = ['chromium', 'zbrowse/browser/zguard'];
const browserCandidates = [
  process.env.CHROMIUM_BIN,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'
].filter(Boolean);
const browser = browserCandidates.find((candidate) =>
  spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0
);
assert.ok(browser, 'A real Chrome/Chromium executable is required; do not skip browser acceptance');

const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<!-- Test targets are synthetic clicks only; CDP target listeners cancel ordinary navigation. -->
<a id="hostile" href="https://ads.al5sm.com/popup" target="_blank">Hostile</a>
<script>
  // Parser-time gesture precedes CDP attachment. The fixture's target
  // listener cancels navigation if zGuard has not already intercepted it.
  // This never opens an external URL even when extension injection races.
  (() => {
    const anchor = document.getElementById('hostile');
    function probeStartupGesture() {
      let reachedTarget = false;
      const cancelFixtureNavigation = (event) => {
        reachedTarget = true;
        event.preventDefault();
      };
      anchor.addEventListener('click', cancelFixtureNavigation, { once: true });
      const event = new MouseEvent('click', {
        bubbles: true, cancelable: true, ctrlKey: true
      });
      anchor.dispatchEvent(event);
      anchor.removeEventListener('click', cancelFixtureNavigation);
      return { blocked: !reachedTarget, cancelled: event.defaultPrevented };
    }
    // Three distinct page lifecycle opportunities let QA distinguish whether
    // extension arming lags only initial parsing or remains late through load.
    // Every event is fixture-cancelled at its target if zGuard misses it.
    const stages = {
      parser: probeStartupGesture(),
      domContentLoaded: null,
      load: null
    };
    window.__zguardStartupStages = stages;
    window.__zguardParserTimeClick = stages.parser;
    document.addEventListener('DOMContentLoaded', () => {
      stages.domContentLoaded = probeStartupGesture();
    }, { once: true });
    window.addEventListener('load', () => {
      stages.load = probeStartupGesture();
    }, { once: true });
  })();
</script>
<a id="hostileRootDot" href="https://WWW.NAP5K.COM./popup" target="_blank">DNS root dot</a>
<a id="hostileNested" href="https://deep.Sub.TMLL7.COM./popup" target="_blank">Nested hostile</a>
<a id="hostileUserInfo" href="https://user:password@ads.al5sm.com/popup" target="_blank">Hostile authority</a>
<a id="ordinary" href="https://example.org/video" target="_blank">Ordinary</a>
<a id="nativeMiddleHostile" href="https://ads.al5sm.com/popup" target="_blank">Middle hostile</a>
<a id="nativeMiddleOrdinary" href="https://example.org/video" target="_blank">Middle ordinary</a>
<a id="lookalikeUserInfo" href="https://ads.al5sm.com@safe.example/watch" target="_blank">Safe authority</a>
<a id="lookalikeSuffix" href="https://al5sm.com.attacker.example./watch" target="_blank">Safe suffix</a>
<a id="sameOrigin" href="/watch" target="_blank">Same origin</a>
<iframe id="childFrame" src="/child" title="Browser interception test frame"></iframe>
</body></html>`;

const childFixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<a id="frameHostile" href="https://ads.al5sm.com/popup" target="_blank">Hostile in frame</a>
<a id="frameOrdinary" href="https://example.org/video" target="_blank">Ordinary in frame</a>
</body></html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(request.url === '/child' ? childFixture : fixture);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The real renderer must have time to load MV3 content scripts and complete
// asynchronous chrome.storage IPC before the page-side interception probe.
async function runBrowser(extensionPath, profilePath, url) {
  const args = [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
    // GitHub-hosted ephemeral CI does not expose Chrome's user-namespace
    // sandbox. This flag is limited to the test Chrome process only; it does
    // NOT relax the separately managed production zBrowse browser container.
    '--no-sandbox',
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync',
    '--disable-extensions-except=' + extensionPath,
    '--load-extension=' + extensionPath,
    '--user-data-dir=' + profilePath,
    '--remote-debugging-port=0', coldStart ? url : 'about:blank'
  ];
  const child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 5000) stderr += chunk.toString();
  });
  let socket;
  try {
    const portFile = path.join(profilePath, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 80 && !fs.existsSync(portFile); attempt += 1) {
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    assert.ok(fs.existsSync(portFile), 'Chromium DevTools did not start (exit=' + child.exitCode + '): ' + stderr.slice(-3000));
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    assert.ok(Number.isSafeInteger(port) && port > 0, 'Invalid local CDP port');
    // DevToolsActivePort can appear before Chrome has published the matching
    // page target. Wait for discovery, not for protection: the earliest page
    // gesture observed after CDP attaches is still assessed below.
    let page;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      assert.equal(response.ok, true, 'Local CDP targets must be available');
      const targets = await response.json();
      page = targets.find((target) => target.type === 'page' &&
        target.url === (coldStart ? url : 'about:blank'));
      if (page?.webSocketDebuggerUrl) break;
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    assert.ok(page?.webSocketDebuggerUrl, 'Expected real browser page target');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    let nextCdpRequestId = 100;
    async function cdp(method, params = {}) {
      const id = nextCdpRequestId++;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.removeEventListener('message', onMessage);
          reject(new Error('CDP ' + method + ' timed out'));
        }, 10000);
        function onMessage(message) {
          const packet = JSON.parse(message.data);
          if (packet.id !== id) return;
          socket.removeEventListener('message', onMessage);
          clearTimeout(timer);
          resolve(packet);
        }
        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ id, method, params }));
      });
      assert.equal(result.error, undefined, 'CDP ' + method + ' failed');
      return result.result;
    }
    // A URL provided on Chrome's command line can start navigating before
    // unpacked MV3 content scripts are registered. That cold-start ordering
    // intermittently omits injection in the top frame while a later iframe
    // receives it. Warm the extension process first, then navigate explicitly.
    if (!coldStart) {
      await sleep(2500);
      const navigation = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP Page.navigate timed out')), 10000);
      socket.addEventListener('message', function onNavigation(message) {
        const packet = JSON.parse(message.data);
        if (packet.id !== 9) return;
        socket.removeEventListener('message', onNavigation);
        clearTimeout(timer);
        resolve(packet);
      });
      socket.send(JSON.stringify({ id: 9, method: 'Page.navigate', params: { url } }));
    });
    assert.equal(navigation.error, undefined, 'real Chromium must navigate to the local fixture');
      assert.equal(navigation.result?.errorText, undefined,
        'real Chromium must not fail local fixture navigation');
    }
    const expression = '(' + (() => {
      function probe(id, context = document) {
        const anchor = context.getElementById(id);
        if (!anchor) throw new Error('Missing fixture anchor ' + id);
        // The browser's real extension runs first at document capture.
        // For allowed links, our target listener prevents navigation so this
        // test never opens/fetches the external destination.
        let reachedTarget = false;
        const cancelAllowedNavigation = (event) => {
          reachedTarget = true;
          event.preventDefault();
        };
        anchor.addEventListener('click', cancelAllowedNavigation, { once: true });
        const event = new MouseEvent('click', {
          bubbles: true, cancelable: true, ctrlKey: true
        });
        anchor.dispatchEvent(event);
        anchor.removeEventListener('click', cancelAllowedNavigation);
        // A blocked link never reaches the target listener. The browser must
        // also reflect cancellation, not merely stop propagation.
        return { blocked: !reachedTarget, cancelled: event.defaultPrevented };
      }
      // CDP can attach before the top navigation has committed. Until the
      // fixture DOM exists, return a readiness sentinel rather than throwing:
      // missing DOM is not evidence that the extension failed interception.
      if (!document.getElementById('hostile') ||
          !document.getElementById('ordinary') ||
          !document.getElementById('childFrame')) {
        return { pageReady: false };
      }
      const hostile = probe('hostile');
      const ordinary = probe('ordinary');
      return {
        pageReady: true,
        parserTimeClick: window.__zguardParserTimeClick ?? null,
        startupStages: window.__zguardStartupStages ?? null,
        hostileClickBlocked: hostile.blocked,
        hostileClickCancelled: hostile.cancelled,
        ordinaryClickBlocked: ordinary.blocked,
        ordinaryClickCancelled: ordinary.cancelled,
        cases: {
          hostileRootDot: probe('hostileRootDot'),
          hostileNested: probe('hostileNested'),
          hostileUserInfo: probe('hostileUserInfo'),
          lookalikeUserInfo: probe('lookalikeUserInfo'),
          lookalikeSuffix: probe('lookalikeSuffix'),
          sameOrigin: probe('sameOrigin'),
          frameHostile: document.getElementById('childFrame')?.contentDocument?.getElementById('frameHostile')
            ? probe('frameHostile', document.getElementById('childFrame').contentDocument)
            : null,
          frameOrdinary: document.getElementById('childFrame')?.contentDocument?.getElementById('frameOrdinary')
            ? probe('frameOrdinary', document.getElementById('childFrame').contentDocument)
            : null
        },
        mainWorldOpenWrapped: window.open.name === 'zGuardWindowOpen'
      };
    }).toString() + ')()';
    // MV3 extension startup and asynchronous storage hydration are not
    // synchronized with the CDP page target. Poll with a bounded deadline,
    // but never accept a false click result as proof of real interception.
    let observed;
    let firstObservedTopFrameProtected = null;
    const deadline = Date.now() + 16000;
    do {
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP evaluation timed out')), 10000);
        socket.addEventListener('message', function handle(message) {
          const packet = JSON.parse(message.data);
          if (packet.id !== 1) return;
          socket.removeEventListener('message', handle);
          clearTimeout(timer);
          resolve(packet);
        });
        socket.send(JSON.stringify({
          id: 1, method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        }));
      });
      if (reply.result?.exceptionDetails) {
        throw new Error('Page probe failed: ' + reply.result.exceptionDetails.text);
      }
      observed = reply.result?.result?.value;
      assert.ok(observed && typeof observed === 'object', 'CDP returned no page probe');
      // Cold-start acceptance must not forgive an initially unprotected click
      // simply because an extension subsequently injects and a later retry
      // succeeds. This observes the earliest fixture click after CDP attach;
      // it cannot establish that no earlier user gesture was possible.
      if (coldStart && observed.pageReady && firstObservedTopFrameProtected === null) {
        firstObservedTopFrameProtected =
          observed.hostileClickBlocked === true && observed.hostileClickCancelled === true;
      }
      // Keep observing after an early failure so all lifecycle stages can be
      // reported. Never rewrite the latched first-observation result.
      if (
        (observed.pageReady && observed.hostileClickBlocked &&
          observed.cases?.frameHostile?.blocked &&
          (!coldStart || observed.startupStages?.load?.cancelled === true)) ||
        Date.now() >= deadline
      ) break;
      await sleep(200);
    } while (true);
    if (requireAuxclick) {
      // This uses Chrome DevTools' *native* middle-button press/release, not
      // an invented click event with button=1. The page target suppresses
      // external navigation if zGuard misses auxclick, while a harmless
      // ordinary middle-click proves Chromium actually emitted auxclick.
      async function nativeMiddleProbe(anchorId) {
        const expression = '(' + ((id) => {
          const anchor = document.getElementById(id);
          if (!anchor) throw new Error('Missing native middle-click anchor');
          anchor.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = anchor.getBoundingClientRect();
          const state = {
            downs: 0, ups: 0, auxclickReached: false,
            trusted: false, cancelledByFixture: false
          };
          window.__zguardNativeMiddleProbe = state;
          anchor.addEventListener('mousedown', (event) => {
            if (event.button === 1) state.downs += 1;
          });
          anchor.addEventListener('mouseup', (event) => {
            if (event.button === 1) state.ups += 1;
          });
          anchor.addEventListener('auxclick', (event) => {
            if (event.button !== 1) return;
            state.auxclickReached = true;
            state.trusted = event.isTrusted;
            event.preventDefault();
            state.cancelledByFixture = event.defaultPrevented;
          }, { once: true });
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }).toString() + ')(' + JSON.stringify(anchorId) + ')';
        const setup = await cdp('Runtime.evaluate', { expression, returnByValue: true });
        assert.equal(setup.exceptionDetails, undefined,
          'Native middle-click fixture setup must succeed');
        const position = setup.result?.value;
        assert.ok(Number.isFinite(position?.x) && Number.isFinite(position?.y),
          'Native middle-click target must have visible coordinates');
        for (const params of [
          { type: 'mouseMoved', button: 'none', buttons: 0 },
          { type: 'mousePressed', button: 'middle', buttons: 4, clickCount: 1 },
          { type: 'mouseReleased', button: 'middle', buttons: 0, clickCount: 1 }
        ]) {
          await cdp('Input.dispatchMouseEvent', { ...position, ...params });
        }
        await sleep(150);
        const observedClick = await cdp('Runtime.evaluate', {
          expression: 'window.__zguardNativeMiddleProbe', returnByValue: true
        });
        assert.equal(observedClick.exceptionDetails, undefined,
          'Native middle-click fixture must remain accessible');
        return observedClick.result?.value;
      }
      observed.nativeMiddleHostile = await nativeMiddleProbe('nativeMiddleHostile');
      observed.nativeMiddleOrdinary = await nativeMiddleProbe('nativeMiddleOrdinary');
    }
    return coldStart ? { ...observed, firstObservedTopFrameProtected } : observed;
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      await Promise.race([stopped, sleep(3000)]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([stopped, sleep(2000)]);
      }
    }
  }
}

const coldStartFailures = [];
try {
  for (const { variant, attempt } of variants.flatMap((name) =>
    Array.from({ length: coldStart ? 3 : 1 }, (_, index) => ({ variant: name, attempt: index + 1 })))) {
    const extensionPath = path.join(root, variant);
    assert.ok(fs.existsSync(path.join(extensionPath, 'manifest.json')),
      variant + ': MV3 manifest must exist');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zguard-chromium-'));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/';
      const observed = await runBrowser(extensionPath, profile, url);
      // Boolean-only evidence; never include navigated URLs or session tokens.
      console.log(variant + (coldStart ? ' cold start #' + attempt : '') +
        ': interception probe=' + JSON.stringify(observed));
      assert.equal(observed.pageReady, true,
        variant + ': real Chrome must finish local fixture navigation before acceptance');
      if (coldStart) {
        for (const stage of ['parser', 'domContentLoaded', 'load']) {
          const gesture = observed.startupStages?.[stage];
          if (gesture?.blocked !== true || gesture?.cancelled !== true) {
            coldStartFailures.push(variant + ' #' + attempt + ' ' + stage +
              ': blocked=' + String(gesture?.blocked) +
              ', cancelled=' + String(gesture?.cancelled));
          }
        }
        if (observed.firstObservedTopFrameProtected !== true) {
          coldStartFailures.push(variant + ' #' + attempt +
            ': first CDP-observed top-frame click was not blocked and cancelled');
        }
      }
      assert.equal(observed.hostileClickBlocked, true,
        variant + ': actual injected extension must cancel hostile Ctrl-click');
      assert.equal(observed.hostileClickCancelled, true,
        variant + ': hostile top-frame gesture must cancel default navigation');
      assert.equal(observed.ordinaryClickBlocked, false,
        variant + ': actual injected extension must preserve ordinary external links');
      assert.equal(observed.ordinaryClickCancelled, true,
        variant + ': fixture must cancel ordinary external navigation');
      for (const label of ['hostileRootDot', 'hostileNested', 'hostileUserInfo']) {
        assert.equal(observed.cases?.[label]?.blocked, true,
          variant + ': real browser must block hostile authority variant ' + label);
        assert.equal(observed.cases[label].cancelled, true,
          variant + ': hostile variant must cancel the original click ' + label);
      }
      for (const label of ['lookalikeUserInfo', 'lookalikeSuffix', 'sameOrigin']) {
        assert.equal(observed.cases?.[label]?.blocked, false,
          variant + ': real browser must not block a harmless authority ' + label);
        assert.equal(observed.cases[label].cancelled, true,
          variant + ': fixture must prevent external navigation for ' + label);
      }

      assert.equal(observed.cases?.frameHostile?.blocked, true,
        variant + ': all_frames must inject zGuard into a genuine same-origin child frame');
      assert.equal(observed.cases.frameHostile.cancelled, true,
        variant + ': hostile frame click must be cancelled before target dispatch');
      assert.equal(observed.cases?.frameOrdinary?.blocked, false,
        variant + ': injected child frame must preserve ordinary navigation');
      assert.equal(observed.cases.frameOrdinary.cancelled, true,
        variant + ': fixture must prevent any outgoing navigation from child frames');
      if (requireAuxclick) {
        for (const name of ['nativeMiddleHostile', 'nativeMiddleOrdinary']) {
          assert.equal(observed[name]?.downs, 1, variant + ': native middle mousedown missing');
          assert.equal(observed[name]?.ups, 1, variant + ': native middle mouseup missing');
        }
        assert.equal(observed.nativeMiddleOrdinary.auxclickReached, true,
          variant + ': harmless native middle-click must reach target listener');
        assert.equal(observed.nativeMiddleOrdinary.trusted, true,
          variant + ': harmless middle-click must be a trusted browser event');
        assert.equal(observed.nativeMiddleOrdinary.cancelledByFixture, true,
          variant + ': harmless native middle-click must not navigate externally');
        assert.equal(observed.nativeMiddleHostile.auxclickReached, false,
          variant + ': hostile native middle-click escaped zGuard auxclick guard');
      }
      if (requireMainWorld) {
        assert.equal(observed.mainWorldOpenWrapped, true,
          variant + ': page window.open is NOT intercepted in MAIN world (issue #3)');
      }
      console.log(variant + ': real Chromium hostile click blocked; ordinary click allowed; ' +
        'authority-matrix=6/6; iframe=2/2; MAIN-world window.open interception=' + observed.mainWorldOpenWrapped);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
// Evaluate all six fresh-profile starts before rejecting. This provides an
// honest failure distribution instead of truncating evidence at the first miss.
if (coldStart) {
  assert.deepEqual(coldStartFailures, [],
    'Cold-start protection failed at one or more lifecycle stages (issue #302):\\n' +
    coldStartFailures.join('\\n'));
}
console.log(requireMainWorld
  ? 'Real-browser MAIN-world acceptance passed'
  : requireAuxclick ? 'Real-browser native middle-click acceptance passed'
    : coldStart ? 'Three actual cold starts per package passed (kiosk race gate)'
      : 'Real-browser click acceptance passed; MAIN-world proof still requires --require-mainworld');
