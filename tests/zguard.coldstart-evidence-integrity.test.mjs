// Offline QA: source-bound integrity of the optional cold-start browser proof.
// It does not run a browser or touch external services. Issue #302 remains open
// until the real kiosk/VPS fresh-profile acceptance is independently verified.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('./zguard.chromium-real-browser.test.mjs', import.meta.url), 'utf8'
);

const required = [
  ['two separately installed browser bundles',
    "const variants = ['chromium', 'zbrowse/browser/zguard'];"],
  ['fresh profile for every cold start',
    "fs.mkdtempSync(path.join(os.tmpdir(), 'zguard-chromium-'))"],
  ['cold start must navigate on Chrome command line',
    "coldStart ? url : 'about:blank'"],
  ['warm navigation must not replace cold-start proof',
    "if (!coldStart) {"],
  ['three independent starts per shipped extension',
    'Array.from({ length: coldStart ? 3 : 1 }'],
  ['parser, DOM ready and load must all be measured',
    "for (const stage of ['parser', 'domContentLoaded', 'load'])"],
  ['record blocked and cancelled at each stage',
    "gesture?.blocked !== true || gesture?.cancelled !== true"],
  ['latch the first observed top-frame result',
    'firstObservedTopFrameProtected === null'],
  ['reject an initially unprotected top frame',
    'observed.firstObservedTopFrameProtected !== true'],
  ['must reject all collected cold-start failures',
    'assert.deepEqual(coldStartFailures, []']
];

function verify(sourceText) {
  for (const [label, needle] of required) {
    assert.ok(sourceText.includes(needle),
      label + ': cold-start release evidence is missing or weakened');
  }
  // Failure aggregation must run after the browser loop; no mid-loop reset
  // may turn a previously observed unsafe startup into a green final result.
  const errorStore = sourceText.indexOf('const coldStartFailures = [];');
  const loop = sourceText.indexOf('for (const { variant, attempt }');
  const acceptance = sourceText.lastIndexOf('assert.deepEqual(coldStartFailures, []');
  assert.ok(errorStore >= 0 && loop > errorStore && acceptance > loop,
    'cold-start failure accounting must bound all attempted fresh launches');
  assert.equal(sourceText.slice(loop, acceptance).includes('coldStartFailures = []'), false,
    'cold-start evidence must never discard failures between attempts');
}
verify(source);

let checked = 0;
for (const [label, oldValue, replacement] of [
  ['wrong launch mode', "coldStart ? url : 'about:blank'",
    "'about:blank'"],
  ['only one start per package', 'coldStart ? 3 : 1',
    'coldStart ? 1 : 1'],
  ['no parser-stage observation',
    "['parser', 'domContentLoaded', 'load']",
    "['domContentLoaded', 'load']"],
  ['ignore first observed unprotected frame',
    'observed.firstObservedTopFrameProtected !== true',
    'false'],
  ['ignore recorded startup failures',
    'assert.deepEqual(coldStartFailures, []',
    'assert.deepEqual([], []']
]) {
  assert.ok(source.includes(oldValue), label + ': mutation fixture missing');
  const mutated = source.replace(oldValue, replacement);
  assert.notEqual(mutated, source, label + ': mutation must alter the harness');
  assert.throws(() => verify(mutated), undefined,
    label + ': a weakened source harness must fail before becoming release proof');
  checked++;
}
console.log('Cold-start evidence integrity PASS: 2 extensions x 3 fresh launches, ' +
  '3 lifecycle stages, early-frame latch and ' + checked + ' negative mutations');
