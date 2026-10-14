// Keep issue #3 a real Firefox MAIN-world release gate, not a green log.
// This is an offline test of the *shipped* native browser test source.
// The real geckodriver test remains the only acceptance of runtime behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(
  new URL('./zguard.firefox-real-browser.test.mjs', import.meta.url), 'utf8'
);
const workflow = fs.readFileSync(
  new URL('../.github/workflows/zguard-real-firefox-acceptance.yml', import.meta.url), 'utf8'
);

function verify(test, yaml) {
  // MAIN-world must be read from real WebDriver page evaluation, not an
  // independent content-script property, constant or an output-only log.
  assert.ok(test.includes(
    'const mainWorld=await evaluate(\'return window.open.name==="zGuardWindowOpen"\');'),
    'main-world result must derive from an evaluated page window.open');
  // The opt-in path must assert the actual measured boolean (not just log
  // or report a baseline success) and must remain inside the live browser
  // session before teardown.
  const required = "if(args.includes('--require-pageworld'))assert.equal(mainWorld,true,";
  const strictOffset = test.lastIndexOf(required);
  const teardown = test.lastIndexOf("}finally{\n  if(session)");
  assert.ok(strictOffset > 0 && teardown > strictOffset,
    'strict page-world acceptance must assert measured Firefox result before teardown');
  assert.ok(test.includes("'Issue #3: Firefox isolated-world wrapper is not MAIN-world protection'"),
    'strict failure must retain its actionable issue attribution');
  // Never let workflow_dispatch silently call the ordinary baseline twice.
  assert.ok(yaml.includes('REQUIRE_PAGEWORLD: ' +
    '$' + "{{ inputs.require_pageworld || 'false' }}"),
    'Firefox strict dispatch input must reach the test runner');
  assert.ok(yaml.includes('node tests/zguard.firefox-real-browser.test.mjs\n' +
    '          if [ "$REQUIRE_PAGEWORLD" = "true" ]; then\n' +
    '            node tests/zguard.firefox-real-browser.test.mjs --require-pageworld\n' +
    '          fi'),
    'strict flag must execute native Firefox after routine regression test');
}
verify(source, workflow);

for (const [label, needle, replacement] of [
  ['page-world replaced with constant',
    "const mainWorld=await evaluate('return window.open.name===\"zGuardWindowOpen\"');",
    'const mainWorld=true;'],
  ['MAIN-world check removed',
    "if(args.includes('--require-pageworld'))assert.equal(mainWorld,true,",
    "if(args.includes('--require-pageworld'))console.log(mainWorld);"],
  ['strict check asserts a constant',
    "if(args.includes('--require-pageworld'))assert.equal(mainWorld,true,",
    "if(args.includes('--require-pageworld'))assert.equal(true,true,"],
  ['strict check disabled',
    "if(args.includes('--require-pageworld'))assert.equal(mainWorld,true,",
    "if(false)assert.equal(mainWorld,true,"]
]) {
  assert.ok(source.includes(needle), label + ': source mutation target required');
  const modified = source.replace(needle, replacement);
  assert.notEqual(modified, source, label + ': mutation must change source');
  assert.throws(() => verify(modified, workflow), undefined,
    label + ': false Firefox MAIN-world green must be rejected');
}
const weakenedDispatch = workflow.replace(
  'node tests/zguard.firefox-real-browser.test.mjs --require-pageworld',
  'node tests/zguard.firefox-real-browser.test.mjs');
assert.notEqual(weakenedDispatch, workflow, 'workflow mutation must change actual strict command');
assert.throws(() => verify(source, weakenedDispatch), undefined,
  'disabled Firefox strict dispatch command cannot become a release pass');

// Exercise the actual Firefox entrypoint with malformed flags before it can
// depend on an XPI, geckodriver or any live/browser environment. An invalid
// operator request must never silently turn into a successful baseline run.
const realEntry = new URL('./zguard.firefox-real-browser.test.mjs', import.meta.url);
const invalidArgs = [
  ['--require-pageword'],
  ['--require-pageworld', '--require-pageworld'],
  ['--require-pageworld=true'],
  ['--require-pageworld', '--unknown'],
  ['--unknown', '--require-pageworld'],
  ['--']
];
for (const args of invalidArgs) {
  const child = spawnSync(process.execPath, [realEntry.pathname, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
    env: { ...process.env, ZGUARD_FIREFOX_XPI: '' }
  });
  assert.equal(child.status, 1, 'invalid Firefox CLI must exit 1 before launching browser');
  assert.match(child.stderr, /Unsupported or duplicate Firefox acceptance flag/,
    'actual Firefox entrypoint must fail at argument validation');
  assert.doesNotMatch(child.stderr, /Set ZGUARD_FIREFOX_XPI|geckodriver is required/,
    'invalid strict flags must be rejected before missing browser prerequisites');
  assert.doesNotMatch(child.stdout, /passed|success|accepted/i,
    'bad Firefox flags may not claim any acceptance');
}
console.log('Firefox MAIN-world issue #3 strict acceptance wiring: 5 mutations plus ' +
  invalidArgs.length + ' real entrypoint CLI rejections PASS (offline)');
