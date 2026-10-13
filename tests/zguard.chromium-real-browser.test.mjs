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
const requireShadowDom = process.argv.includes('--require-shadow-dom');
const requireFormSubmit = process.argv.includes('--require-form-submit');
const requireImageMap = process.argv.includes('--require-image-map');
const requireSvgLink = process.argv.includes('--require-svg-link');
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
    if (!coldStart) {
      // Keyboard Enter is a distinct trusted activation path: Chromium
      // synthesizes a click (detail=0) on the focused HTML anchor. Testing
      // it in the actual loaded MV3 extension protects keyboard users.
      async function nativeKeyboardProbe(anchorId) {
        const setup = await cdp('Runtime.evaluate', {
          expression: '(' + ((id) => {
            const anchor = document.getElementById(id);
            if (!anchor) throw new Error('Missing keyboard-activation anchor');
            const state = {
              keydownSeen: false, keyTrusted: false,
              clickReachedTarget: false, clickTrusted: false,
              clickDetail: null, cancelledByFixture: false,
              clickSeenInCapture: false
            };
            window.__zguardKeyboardState = state;
            function onKey(event) {
              if (event.key === 'Enter') {
                state.keydownSeen = true;
                state.keyTrusted = event.isTrusted;
              }
            }
            function onDocumentClick(event) {
              if (event.target === anchor) state.clickSeenInCapture = true;
            }
            function onTargetClick(event) {
              state.clickReachedTarget = true;
              state.clickTrusted = event.isTrusted;
              state.clickDetail = event.detail;
              event.preventDefault();
              state.cancelledByFixture = event.defaultPrevented;
            }
            anchor.addEventListener('keydown', onKey);
            document.addEventListener('click', onDocumentClick, true);
            anchor.addEventListener('click', onTargetClick);
            window.__zguardKeyboardCleanup = () => {
              anchor.removeEventListener('keydown', onKey);
              document.removeEventListener('click', onDocumentClick, true);
              anchor.removeEventListener('click', onTargetClick);
            };
            anchor.focus();
            return { focused: document.activeElement === anchor };
          }).toString() + ')(' + JSON.stringify(anchorId) + ')',
          returnByValue: true
        });
        assert.equal(setup.exceptionDetails, undefined,
          'Real keyboard activation setup must evaluate');
        assert.equal(setup.result?.value?.focused, true,
          'Real keyboard activation must target a focused link');
        for (const type of ['keyDown', 'keyUp']) {
          await cdp('Input.dispatchKeyEvent', {
            type, key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
          });
        }
        await sleep(80);
        const observedKey = await cdp('Runtime.evaluate', {
          expression: '(() => { const result = window.__zguardKeyboardState; ' +
            'window.__zguardKeyboardCleanup(); return result; })()',
          returnByValue: true
        });
        assert.equal(observedKey.exceptionDetails, undefined,
          'Real keyboard probe must remain accessible');
        return observedKey.result?.value;
      }
      observed.keyboard = {
        hostile: await nativeKeyboardProbe('hostile'),
        ordinary: await nativeKeyboardProbe('ordinary')
      };
    }
    if (requireSvgLink) {
      // Real SVG <a> links expose SVGAnimatedString href/target properties
      // instead of the HTMLAnchorElement strings handled by content.js.
      // Actual mouse input exercises hit-testing on a visible nested rect.
      async function svgLinkProbe(kind, href) {
        const setup = await cdp('Runtime.evaluate', {
          expression: '(' + ((variant, url) => {
            const ns = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('width', '120');
            svg.setAttribute('height', '60');
            const link = document.createElementNS(ns, 'a');
            link.setAttribute('href', url);
            link.setAttribute('target', '_blank');
            const rect = document.createElementNS(ns, 'rect');
            rect.setAttribute('width', '120');
            rect.setAttribute('height', '60');
            rect.setAttribute('fill', 'lightgray');
            link.append(rect);
            svg.append(link);
            document.body.append(svg);
            const state = {
              reachedLink: false, trusted: false,
              seenSvgAtCapture: false, cancelledByFixture: false,
              closestIsSvgLink: false,
              hrefIsAnimated: typeof link.href === 'object' &&
                typeof link.href.baseVal === 'string',
              targetIsAnimated: typeof link.target === 'object' &&
                typeof link.target.baseVal === 'string'
            };
            window.__zguardSvgState = state;
            function safeCapture(event) {
              if (!event.composedPath().includes(link)) return;
              state.seenSvgAtCapture = true;
              state.closestIsSvgLink = event.target.closest('a') === link;
              event.preventDefault();
              state.cancelledByFixture = event.defaultPrevented;
            }
            function onTarget(event) {
              state.reachedLink = true;
              state.trusted = event.isTrusted;
              event.preventDefault();
              state.cancelledByFixture = event.defaultPrevented;
            }
            document.addEventListener('click', safeCapture, true);
            link.addEventListener('click', onTarget);
            window.__zguardSvgCleanup = () => {
              document.removeEventListener('click', safeCapture, true);
              link.removeEventListener('click', onTarget);
              svg.remove();
            };
            svg.scrollIntoView({ block: 'center' });
            const bounds = rect.getBoundingClientRect();
            return { x: bounds.left + bounds.width / 2,
              y: bounds.top + bounds.height / 2 };
          }).toString() + ')(' + JSON.stringify(kind) + ',' + JSON.stringify(href) + ')',
          returnByValue: true
        });
        assert.equal(setup.exceptionDetails, undefined, 'SVG fixture setup must run');
        const pos = setup.result?.value;
        assert.ok(Number.isFinite(pos?.x) && Number.isFinite(pos?.y),
          'SVG hyperlink hit target must be onscreen');
        for (const params of [
          { type: 'mouseMoved', button: 'none', buttons: 0 },
          { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 },
          { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 }
        ]) {
          await cdp('Input.dispatchMouseEvent', { ...pos, ...params });
        }
        const response = await cdp('Runtime.evaluate', {
          expression: '(() => { const state = window.__zguardSvgState; ' +
            'window.__zguardSvgCleanup(); return state; })()',
          returnByValue: true
        });
        assert.equal(response.exceptionDetails, undefined,
          'SVG click fixture must remain accessible');
        return response.result?.value;
      }
      observed.svgLink = {
        hostile: await svgLinkProbe('hostile', 'https://ads.al5sm.com/popup'),
        ordinary: await svgLinkProbe('ordinary', 'https://example.org/video')
      };
    }
    if (requireImageMap) {
      // Actual Chrome mouse input activates HTML <area> map hotspots, not
      // synthetic anchor MouseEvents. Fixture document capture cancels every
      // external navigation if the extension fails to intercept.
      async function imageMapProbe(kind, href) {
        const prepare = await cdp('Runtime.evaluate', {
          expression: '(' + ((variant, url) => {
            const mapName = 'zguard-qa-map-' + variant;
            const map = document.createElement('map');
            map.name = mapName;
            const area = document.createElement('area');
            area.alt = variant;
            area.shape = 'rect';
            area.coords = '0,0,120,60';
            area.href = url;
            area.target = '_blank';
            map.append(area);
            const img = document.createElement('img');
            img.alt = 'Local test image map';
            img.width = 120;
            img.height = 60;
            img.useMap = '#' + mapName;
            img.src = 'data:image/svg+xml,' +
              encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">' +
                '<rect width="120" height="60" fill="lightgray"/></svg>');
            document.body.append(map, img);
            const state = {
              reachedArea: false, eventTrusted: false, seenAreaAtCapture: false,
              cancelledByFixture: false
            };
            window.__zguardImageMapState = state;
            function safety(event) {
              if (!event.composedPath().includes(area)) return;
              state.seenAreaAtCapture = event.target === area;
              event.preventDefault();
              state.cancelledByFixture = event.defaultPrevented;
            }
            function target(event) {
              state.reachedArea = true;
              state.eventTrusted = event.isTrusted;
              event.preventDefault();
              state.cancelledByFixture = event.defaultPrevented;
            }
            document.addEventListener('click', safety, true);
            area.addEventListener('click', target, { once: true });
            window.__zguardImageMapCleanup = () => {
              document.removeEventListener('click', safety, true);
              area.removeEventListener('click', target);
              img.remove();
              map.remove();
            };
            img.scrollIntoView({ block: 'center' });
            const rect = img.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }).toString() + ')(' + JSON.stringify(kind) + ',' + JSON.stringify(href) + ')',
          returnByValue: true
        });
        assert.equal(prepare.exceptionDetails, undefined,
          'Image-map fixture must load');
        const position = prepare.result?.value;
        assert.ok(Number.isFinite(position?.x) && Number.isFinite(position?.y),
          'Image-map hotspot must have visible coordinates');
        // Browser-native mouse events are trusted; the real image-map hit
        // testing must dispatch a click targeting <area>, not <img>.
        for (const params of [
          { type: 'mouseMoved', button: 'none', buttons: 0 },
          { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 },
          { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 }
        ]) {
          await cdp('Input.dispatchMouseEvent', { ...position, ...params });
        }
        const checked = await cdp('Runtime.evaluate', {
          expression: '(() => { const observed = window.__zguardImageMapState; ' +
            'window.__zguardImageMapCleanup(); return observed; })()',
          returnByValue: true
        });
        assert.equal(checked.exceptionDetails, undefined,
          'Image-map fixture must remain accessible');
        return checked.result?.value;
      }
      observed.imageMap = {
        hostile: await imageMapProbe('hostile', 'https://ads.al5sm.com/popup'),
        ordinary: await imageMapProbe('ordinary', 'https://example.org/watch')
      };
    }
    if (requireFormSubmit) {
      // Real DOM form.requestSubmit creates an HTML submit event; unlike an
      // anchor click, zGuard's current capture listener does not watch submit.
      // The fixture's form-target listener cancels navigation on a miss.
      const evaluated = await cdp('Runtime.evaluate', {
        expression: '(' + (() => {
          function submitForm(action) {
            const form = document.createElement('form');
            form.action = action;
            form.method = 'GET';
            form.target = '_blank';
            document.body.append(form);
            let reachedTarget = false;
            let cancelledByFixture = false;
            let seenOnDocument = false;
            let trustedAtTarget = false;
            function observe(event) {
              if (event.target === form) seenOnDocument = true;
            }
            function cancel(event) {
              reachedTarget = true;
              trustedAtTarget = event.isTrusted;
              event.preventDefault();
              cancelledByFixture = event.defaultPrevented;
            }
            document.addEventListener('submit', observe, true);
            form.addEventListener('submit', cancel, { once: true });
            try {
              form.requestSubmit();
            } finally {
              document.removeEventListener('submit', observe, true);
              form.removeEventListener('submit', cancel);
              form.remove();
            }
            return { blocked: !reachedTarget, cancelledByFixture,
              seenOnDocument, trustedAtTarget };
          }
          return {
            hostile: submitForm('https://ads.al5sm.com/popup'),
            ordinary: submitForm('https://example.org/video')
          };
        }).toString() + ')()',
        returnByValue: true
      });
      assert.equal(evaluated.exceptionDetails, undefined,
        'Real HTML form submission fixture must evaluate');
      observed.formSubmit = evaluated.result?.value;
    }
    if (requireShadowDom) {
      // The browser, not our VM, retargets composed clicks from a real
      // shadow root to its host at document capture. A target-only fixture
      // handler cancels missed clicks, so no external site can be opened.
      const evaluated = await cdp('Runtime.evaluate', {
        expression: '(' + (() => {
          function shadowClick(href) {
            const host = document.createElement('div');
            document.body.append(host);
            const shadow = host.attachShadow({ mode: 'open' });
            const anchor = document.createElement('a');
            anchor.href = href;
            anchor.target = '_blank';
            anchor.textContent = 'Fixture shadow anchor';
            shadow.append(anchor);
            let targetReached = false;
            let retargeted = false;
            function cancelFixtureNavigation(event) {
              targetReached = true;
              event.preventDefault();
            }
            function documentObserver(event) {
              retargeted = event.target === host &&
                event.composedPath()[0] === anchor;
            }
            document.addEventListener('click', documentObserver, true);
            anchor.addEventListener('click', cancelFixtureNavigation, { once: true });
            const event = new MouseEvent('click', {
              bubbles: true, composed: true, cancelable: true, ctrlKey: true
            });
            anchor.dispatchEvent(event);
            document.removeEventListener('click', documentObserver, true);
            anchor.removeEventListener('click', cancelFixtureNavigation);
            host.remove();
            return { blocked: !targetReached, cancelled: event.defaultPrevented,
              retargeted, composed: event.composed };
          }
          return {
            hostile: shadowClick('https://ads.al5sm.com/popup'),
            ordinary: shadowClick('https://example.org/video')
          };
        }).toString() + ')()',
        returnByValue: true
      });
      assert.equal(evaluated.exceptionDetails, undefined,
        'Real shadow-root click fixture must evaluate');
      observed.shadowDom = evaluated.result?.value;
    }
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
      if (!coldStart) {
        for (const role of ['hostile', 'ordinary']) {
          assert.equal(observed.keyboard?.[role]?.keydownSeen, true,
            variant + ': native keyboard Enter must deliver a real keydown for ' + role);
          assert.equal(observed.keyboard[role].keyTrusted, true,
            variant + ': keyboard Enter must be trusted for ' + role);
        }
        assert.equal(observed.keyboard.ordinary.clickSeenInCapture, true,
          variant + ': ordinary keyboard Enter must create a click seen at document capture');
        assert.equal(observed.keyboard.ordinary.clickReachedTarget, true,
          variant + ': ordinary keyboard link must remain operable');
        assert.equal(observed.keyboard.ordinary.clickTrusted, true,
          variant + ': keyboard activation click must be browser-trusted');
        assert.equal(observed.keyboard.ordinary.clickDetail, 0,
          variant + ': keyboard activation must be distinguishable from pointer clicks');
        assert.equal(observed.keyboard.ordinary.cancelledByFixture, true,
          variant + ': fixture must cancel allowed keyboard external navigation');
        assert.equal(observed.keyboard.hostile.clickReachedTarget, false,
          variant + ': hostile keyboard-activated target=_blank link escaped popup guard');
      }
      if (requireSvgLink) {
        assert.equal(observed.svgLink?.ordinary?.seenSvgAtCapture, true,
          variant + ': real SVG link click must be observed in document capture');
        assert.equal(observed.svgLink.ordinary.closestIsSvgLink, true,
          variant + ': browser must resolve SVG link via closest(a)');
        assert.equal(observed.svgLink.ordinary.reachedLink, true,
          variant + ': ordinary SVG target=_blank navigation must remain available');
        assert.equal(observed.svgLink.ordinary.trusted, true,
          variant + ': ordinary SVG click must be a real browser event');
        assert.equal(observed.svgLink.ordinary.cancelledByFixture, true,
          variant + ': fixture must cancel ordinary SVG external navigation');
        assert.equal(observed.svgLink.hostile.reachedLink, false,
          variant + ': hostile SVG target=_blank link escaped popup guard');
      }
      if (requireImageMap) {
        assert.equal(observed.imageMap?.ordinary?.seenAreaAtCapture, true,
          variant + ': real image-map hit-testing must target an HTML area');
        assert.equal(observed.imageMap?.ordinary?.reachedArea, true,
          variant + ': ordinary image-map navigation must be allowed');
        assert.equal(observed.imageMap?.ordinary?.eventTrusted, true,
          variant + ': image-map fixture must use trusted real mouse events');
        assert.equal(observed.imageMap?.ordinary?.cancelledByFixture, true,
          variant + ': ordinary external image-map navigation must be cancelled safely');
        assert.equal(observed.imageMap?.hostile?.reachedArea, false,
          variant + ': hostile image-map area click escaped popup guard');
      }
      if (requireFormSubmit) {
        assert.equal(observed.formSubmit?.ordinary?.seenOnDocument, true,
          variant + ': ordinary form submission must reach document capture');
        assert.equal(observed.formSubmit?.ordinary?.blocked, false,
          variant + ': ordinary external target=_blank form must remain available');
        assert.equal(observed.formSubmit?.ordinary?.cancelledByFixture, true,
          variant + ': fixture must prevent any external form navigation');
        assert.equal(observed.formSubmit?.hostile?.blocked, true,
          variant + ': hostile target=_blank form escaped extension submit guard');
      }
      if (requireShadowDom) {
        assert.equal(observed.shadowDom?.ordinary?.composed, true,
          variant + ': ordinary shadow click must be a composed DOM event');
        assert.equal(observed.shadowDom?.ordinary?.retargeted, true,
          variant + ': Chromium must retarget shadow click to the host at document capture');
        assert.equal(observed.shadowDom?.ordinary?.blocked, false,
          variant + ': normal shadow link should remain available');
        assert.equal(observed.shadowDom?.ordinary?.cancelled, true,
          variant + ': fixture must cancel normal external navigation');
        assert.equal(observed.shadowDom?.hostile?.blocked, true,
          variant + ': hostile shadow-root anchor escaped the popup click guard');
        assert.equal(observed.shadowDom?.hostile?.cancelled, true,
          variant + ': hostile shadow-root anchor must cancel navigation');
      }
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
  : requireSvgLink ? 'Real-browser SVG hyperlink popup acceptance passed'
    : requireImageMap ? 'Real-browser HTML image-map popup acceptance passed'
    : requireFormSubmit ? 'Real-browser form target=_blank acceptance passed'
    : requireShadowDom ? 'Real-browser shadow DOM click acceptance passed'
    : requireAuxclick ? 'Real-browser native middle-click acceptance passed'
    : coldStart ? 'Three actual cold starts per package passed (kiosk race gate)'
      : 'Real-browser click acceptance passed; MAIN-world proof still requires --require-mainworld');
