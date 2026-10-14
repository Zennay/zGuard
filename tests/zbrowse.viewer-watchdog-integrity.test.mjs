// Fail closed if a future refactor weakens the reviewed TV iframe loading
// watchdog, its cleanup/error boundary, or its real-browser acceptance.
// This gate inspects shipped source and test evidence; it never makes HTTP
// calls, creates sessions, connects to VPS or starts a browser itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(
  new URL('../zbrowse/gateway/public/app.js', import.meta.url), 'utf8');
const frontend = fs.readFileSync(
  new URL('./zbrowse.frontend-session.test.js', import.meta.url), 'utf8');
const chromium = fs.readFileSync(
  new URL('./zbrowse.portal-real-chromium.test.mjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(
  new URL('../.github/workflows/portal-accessibility-validation.yml', import.meta.url), 'utf8');

function verify(runtime, dom, browser, ci) {
  const viewerStart = runtime.indexOf('function showBrowser() {');
  const viewerEnd = runtime.indexOf('function updateTimer()', viewerStart);
  const endStart = runtime.indexOf('async function endSession() {');
  const endEnd = runtime.indexOf('function isReviewedStartUrl(', endStart);
  assert.ok(viewerStart > 0 && viewerEnd > viewerStart &&
    endStart > viewerEnd && endEnd > endStart,
    'actual TV viewer and teardown source must be present');
  const start = runtime.slice(viewerStart, viewerEnd);
  const teardown = runtime.slice(endStart, endEnd);
  for (const [name, anchor] of [
    ['30s load deadline', '}, 30000);'],
    ['owned timeout ID', 'const loadTimeoutId = window.setTimeout(() => {'],
    ['ignore queued stale callback',
      'state.viewerLoadTimeout !== loadTimeoutId || state.session !== session'],
    ['save active deadline', 'state.viewerLoadTimeout = loadTimeoutId;'],
    ['close timed-out browser', 'endSession().then(() => {'],
    ['preserve failed DELETE warning', '!state.session && !pendingReleaseToken && !sessionStarting'],
    ['clear stale error with actionable guidance', 'Browser stream did not load. Try again.'],
    ['successful load cancels timer', 'window.clearTimeout(state.viewerLoadTimeout);'],
    ['successful load disarms timer', 'state.viewerLoadTimeout = null;'],
    ['load listener registered', 'frame.addEventListener("load", () => {'],
    ['browser navigation occurs', 'frame.src = session.viewerUrl;'],
    ['session identity on load', 'if (state.session === session) {']
  ]) {
    assert.ok(start.includes(anchor), 'viewer watchdog: ' + name);
  }
  assert.ok(start.indexOf('frame.addEventListener("load"') <
    start.indexOf('frame.src = session.viewerUrl;'),
    'load handler must be registered BEFORE iframe navigation');
  assert.ok(start.indexOf('state.viewerLoadTimeout = loadTimeoutId;') <
    start.indexOf('frame.src = session.viewerUrl;'),
    'watchdog must guard the entire initial navigation');
  for (const [name, anchor] of [
    ['stop outstanding load timer', 'window.clearTimeout(state.viewerLoadTimeout);'],
    ['clear active timer ID', 'state.viewerLoadTimeout = null;'],
    ['detach bearer iframe', '$("browserFrame").src = "about:blank";'],
    ['keep uncertain teardown blocked', 'pendingReleaseToken = state.session.token;'],
    ['reconcile cleanup', 'await releasePendingSession();']
  ]) assert.ok(teardown.includes(anchor), 'viewer release: ' + name);

  for (const anchor of [
    'neverLoaded.timeouts.size, 1',
    'watchdog.callback();',
    'neverLoaded.element(\'browserFrame\').src, \'about:blank\'',
    'neverLoaded.element(\'urlInput\').focused, true',
    'previousWatchdog.callback();',
    'stale callback cannot tear down loaded viewer',
    'failedViewer.element(\'startButton\').disabled, true',
    'failedViewer.element(\'formMessage\').textContent, /Retrying automatically/',
    'timeoutDeletes, 2'
  ]) assert.ok(dom.includes(anchor), 'source-backed DOM acceptance missing ' + anchor);
  for (const anchor of [
    'window.__qaViewerWatchdog = callback;',
    'window.__qaViewerWatchdog(); true',
    'state.viewerLoadTimeout',
    'beforeStaleWatchdogDeletes',
    'loaded viewer must never be DELETEd by a stale callback'
  ]) assert.ok(browser.includes(anchor),
    'real Chromium watchdog acceptance missing ' + anchor);
  for (const command of [
    'node tests/zbrowse.frontend-session.test.js',
    'node tests/zbrowse.viewer-watchdog-integrity.test.mjs',
    'node tests/zbrowse.portal-workflow-coverage.test.mjs'
  ]) assert.ok(ci.includes(command), 'hosted portal CI must run ' + command);
  assert.ok(ci.includes('"tests/zbrowse.viewer-watchdog-integrity.test.mjs"'),
    'the new integrity test must trigger portal CI when changed');
}

verify(app, frontend, chromium, workflow);
let mutations = 0;
for (const [name, target, original, corrupted] of [
  ['zero-second timeout', 'app', '}, 30000);', '}, 0);'],
  ['skip timer identity', 'app',
    'state.viewerLoadTimeout !== loadTimeoutId || state.session !== session',
    'state.session !== session'],
  ['skip session identity', 'app',
    'state.viewerLoadTimeout !== loadTimeoutId || state.session !== session',
    'state.viewerLoadTimeout !== loadTimeoutId'],
  ['skip timeout clear', 'app',
    'window.clearTimeout(state.viewerLoadTimeout);', 'void state.viewerLoadTimeout;'],
  ['skip uncertain teardown lock', 'app',
    '!state.session && !pendingReleaseToken && !sessionStarting',
    '!state.session && !sessionStarting'],
  ['fake successful timeout recovery', 'app',
    'endSession().then(() => {', 'Promise.resolve().then(() => {'],
  ['weaken DOM timeout proof', 'frontend',
    'watchdog.callback();', 'void watchdog.callback;'],
  ['disable real Chromium stale callback', 'chromium',
    'window.__qaViewerWatchdog(); true', 'true'],
  ['remove CI execution', 'workflow',
    'node tests/zbrowse.viewer-watchdog-integrity.test.mjs',
    'echo skipped-viewer-integrity']
]) {
  const input = { app, frontend, chromium, workflow }[target];
  assert.ok(input.includes(original),
    name + ': negative mutation must target actual reviewed source');
  const mutated = input.replace(original, corrupted);
  assert.notEqual(mutated, input, name + ': mutation must change source');
  const bundle = { app, frontend, chromium, workflow, [target]: mutated };
  assert.throws(() => verify(bundle.app, bundle.frontend,
    bundle.chromium, bundle.workflow), undefined,
  name + ': weakening the shipped boundary must reject release evidence');
  mutations++;
}
console.log('TV viewer load watchdog source and real-browser evidence PASS: ' +
  mutations + ' negative mutations');
