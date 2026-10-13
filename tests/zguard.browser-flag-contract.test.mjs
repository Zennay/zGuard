import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptedBrowserFlags, parseAcceptanceFlags } from '../tools/real-browser-flags.mjs';

const expected = new Map([
  ['--require-mainworld', 'requireMainWorld'],
  ['--cold-start', 'coldStart'],
  ['--require-auxclick', 'requireAuxclick'],
  ['--require-shadow-dom', 'requireShadowDom'],
  ['--require-form-submit', 'requireFormSubmit'],
  ['--require-image-map', 'requireImageMap'],
  ['--require-svg-link', 'requireSvgLink']
]);

assert.deepEqual(acceptedBrowserFlags, [...expected.keys()]);
assert.equal(Object.values(parseAcceptanceFlags([])).every((value) => value === false), true,
  'ordinary PR/push test must not implicitly opt into open strict gates');

for (const [flag, key] of expected) {
  const parsed = parseAcceptanceFlags([flag]);
  assert.equal(parsed[key], true, flag + ': strict gate must be enabled');
  assert.equal(Object.values(parsed).filter(Boolean).length, 1,
    flag + ': a single flag must select exactly one strict gate');
  assert.equal(Object.isFrozen(parsed), true, 'selected options must be immutable');
}

const all = parseAcceptanceFlags([...expected.keys()]);
assert.equal(Object.values(all).filter(Boolean).length, expected.size,
  'all independently selected strict gates must remain enabled together');

for (const invalid of [
  ['--require-auxclik'],
  ['--require-image-map=false'],
  ['--require-svg-link', '--require-svg-link'],
  ['--cold-start', '--cold-start'],
  ['--require-auxclick', '--unknown'],
  ['--'],
  ['--require-auxclick', 'true'],
  ['--require-mainworld=1'],
  [''],
  [null]
]) {
  assert.throws(() => parseAcceptanceFlags(invalid), /Unsupported|Duplicate/,
    JSON.stringify(invalid) + ': malformed flags must never silently fall back');
}
assert.throws(() => parseAcceptanceFlags('--require-auxclick'), TypeError,
  'one string is not an argv array');

// The actual browser CLI must reject unknown arguments BEFORE looking for a
// browser executable. This is a lightweight source-wired negative test, not
// a substitute for the real Chromium acceptance on the normal CI path.
const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  'zguard.chromium-real-browser.test.mjs');
for (const args of [
  ['--require-auxclik'],
  ['--require-form-submit', '--require-form-submit'],
  ['--require-svg-link=1']
]) {
  const child = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CHROMIUM_BIN: '/nonexistent-test-browser' }
  });
  assert.equal(child.status, 1, 'real-browser CLI must reject invalid arguments');
  assert.match(child.stderr, /Unsupported real-browser acceptance argument|Duplicate real-browser acceptance argument/,
    'real-browser CLI must actually execute the strict parser');
  assert.doesNotMatch(child.stderr, /A real Chrome\/Chromium executable is required/,
    'argument errors must fail before browser-dependent acceptance');
}
console.log('Real-browser acceptance argument contract passed (7 gates, invalid/duplicate fail-closed)');
