// Both real token-privacy QA commands must reject malformed opt-in
// arguments before executing a gateway session/viewer fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireExactCachePrivacyFlag } from '../tools/cache-privacy-flags.mjs';

assert.equal(requireExactCachePrivacyFlag([]), false, 'baseline mode is not strict evidence');
assert.equal(requireExactCachePrivacyFlag(['--require-no-store']), true,
  'the sole reviewed strict opt-in must remain available');

const invalid = [
  ['--require-nostore'],
  ['--require-no-store=true'],
  ['--require-no-store', '--require-no-store'],
  ['--require-no-store', '--unknown'],
  ['--live'],
  ['']
];
for (const args of invalid) {
  assert.throws(() => requireExactCachePrivacyFlag(args), /Unsupported cache-privacy/,
    'invalid flags must fail closed rather than selecting baseline mode');
}
for (const entry of [
  'zbrowse.session-cache-privacy.test.mjs',
  'zbrowse.viewer-cache-privacy.test.mjs'
]) {
  for (const args of invalid) {
    const result = spawnSync(process.execPath,
      [path.resolve(path.dirname(fileURLToPath(import.meta.url)), entry), ...args],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, entry + ': malformed flags must reject');
    assert.match(result.stderr, /Unsupported cache-privacy acceptance arguments/,
      entry + ': real CLI must execute the strict parser');
    assert.doesNotMatch(result.stdout, /contract passed|no-store boundary passed|no-store PASS|Actual gateway/,
      entry + ': invalid CLI must not display success-like baseline evidence');
  }
}
console.log('Both gateway token-cache QA CLIs reject malformed strict acceptance flags');
