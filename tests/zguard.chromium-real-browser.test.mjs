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
<a id="hostile" href="https://ads.al5sm.com/popup" target="_blank">Hostile</a>
<a id="ordinary" href="https://example.org/video" target="_blank">Ordinary</a>
<output id="zguard-probe"></output>
<script>
setTimeout(() => {
  const evaluate = (id) => {
    const target = document.getElementById(id);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    target.dispatchEvent(event);
    const blocked = event.defaultPrevented;
    // A programmatic event is not a user gesture. Explicitly suppress any
    // browser navigation after measuring whether zGuard handled the click.
    if (!blocked) event.preventDefault();
    return blocked;
  };
  const result = {
    hostileClickBlocked: evaluate('hostile'),
    ordinaryClickBlocked: evaluate('ordinary'),
    mainWorldOpenWrapped: window.open.name === 'zGuardWindowOpen'
  };
  document.getElementById('zguard-probe').textContent = JSON.stringify(result);
}, 1200);
</script></body></html>`;

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

function runBrowser(extensionPath, profilePath, url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
      '--user-data-dir=' + profilePath,
      '--virtual-time-budget=5000',
      '--dump-dom',
      url
    ];
    // Only a root-owned development/container invocation needs this flag.
    // Hosted GitHub CI executes unprivileged and retains Chromium sandboxing.
    if (process.getuid?.() === 0) args.unshift('--no-sandbox');
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 10000) stderr += chunk.toString();
    });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error('Chromium exited ' + code + ': ' + stderr.slice(-2000)));
      } else resolve(stdout);
    });
  });
}

try {
  for (const variant of variants) {
    const extensionPath = path.join(root, variant);
    assert.ok(fs.existsSync(path.join(extensionPath, 'manifest.json')),
      variant + ': MV3 manifest must exist');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zguard-chromium-'));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/';
      const dom = await runBrowser(extensionPath, profile, url);
      const match = dom.match(/<output id="zguard-probe">([^<]+)<\/output>/);
      assert.ok(match, variant + ': no browser-side result; extension/fixture did not finish');
      const observed = JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
      assert.equal(observed.hostileClickBlocked, true,
        variant + ': actual injected extension must cancel hostile Ctrl-click');
      assert.equal(observed.ordinaryClickBlocked, false,
        variant + ': actual injected extension must preserve ordinary external links');
      if (requireMainWorld) {
        assert.equal(observed.mainWorldOpenWrapped, true,
          variant + ': page window.open is NOT intercepted in MAIN world (issue #3)');
      }
      console.log(variant + ': real Chromium hostile click blocked; ordinary click allowed; ' +
        'MAIN-world window.open interception=' + observed.mainWorldOpenWrapped);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log(requireMainWorld
  ? 'Real-browser MAIN-world acceptance passed'
  : 'Real-browser click acceptance passed; MAIN-world proof still requires --require-mainworld');
