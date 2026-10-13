// Real headless Chromium runs the shipped MV3 extension, not a VM mock.
// This test deliberately does not claim to prove MAIN-world window.open
// interception until invoked with --require-mainworld.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireMainWorld = process.argv.includes('--require-mainworld');
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
<a id="hostileRootDot" href="https://WWW.NAP5K.COM./popup" target="_blank">DNS root dot</a>
<a id="hostileNested" href="https://deep.Sub.TMLL7.COM./popup" target="_blank">Nested hostile</a>
<a id="hostileUserInfo" href="https://user:password@ads.al5sm.com/popup" target="_blank">Hostile authority</a>
<a id="ordinary" href="https://example.org/video" target="_blank">Ordinary</a>
<a id="lookalikeUserInfo" href="https://ads.al5sm.com@safe.example/watch" target="_blank">Safe authority</a>
<a id="lookalikeSuffix" href="https://al5sm.com.attacker.example./watch" target="_blank">Safe suffix</a>
<a id="sameOrigin" href="/watch" target="_blank">Same origin</a>
</body></html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(fixture);
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
    '--remote-debugging-port=0', url
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
    const response = await fetch('http://127.0.0.1:' + port + '/json/list');
    assert.equal(response.ok, true, 'Local CDP targets must be available');
    const targets = await response.json();
    const page = targets.find((target) => target.type === 'page' && target.url === url);
    assert.ok(page?.webSocketDebuggerUrl, 'Expected real browser page target');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    await sleep(500);
    const expression = '(' + (() => {
      function probe(id) {
        const anchor = document.getElementById(id);
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
      return {
        hostileClickBlocked: probe('hostile').blocked,
        ordinaryClickBlocked: probe('ordinary').blocked,
        cases: {
          hostileRootDot: probe('hostileRootDot'),
          hostileNested: probe('hostileNested'),
          hostileUserInfo: probe('hostileUserInfo'),
          lookalikeUserInfo: probe('lookalikeUserInfo'),
          lookalikeSuffix: probe('lookalikeSuffix'),
          sameOrigin: probe('sameOrigin')
        },
        mainWorldOpenWrapped: window.open.name === 'zGuardWindowOpen'
      };
    }).toString() + ')()';
    // MV3 extension startup and asynchronous storage hydration are not
    // synchronized with the CDP page target. Poll with a bounded deadline,
    // but never accept a false click result as proof of real interception.
    let observed;
    const deadline = Date.now() + 8000;
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
      if (observed.hostileClickBlocked || Date.now() >= deadline) break;
      await sleep(200);
    } while (true);
    return observed;
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

try {
  for (const variant of variants) {
    const extensionPath = path.join(root, variant);
    assert.ok(fs.existsSync(path.join(extensionPath, 'manifest.json')),
      variant + ': MV3 manifest must exist');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zguard-chromium-'));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/';
      const observed = await runBrowser(extensionPath, profile, url);
      assert.equal(observed.hostileClickBlocked, true,
        variant + ': actual injected extension must cancel hostile Ctrl-click');
      assert.equal(observed.ordinaryClickBlocked, false,
        variant + ': actual injected extension must preserve ordinary external links');
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

      if (requireMainWorld) {
        assert.equal(observed.mainWorldOpenWrapped, true,
          variant + ': page window.open is NOT intercepted in MAIN world (issue #3)');
      }
      console.log(variant + ': real Chromium hostile click blocked; ordinary click allowed; ' +
        'authority-matrix=6/6; MAIN-world window.open interception=' + observed.mainWorldOpenWrapped);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log(requireMainWorld
  ? 'Real-browser MAIN-world acceptance passed'
  : 'Real-browser click acceptance passed; MAIN-world proof still requires --require-mainworld');
