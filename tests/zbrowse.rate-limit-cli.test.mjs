// Negative actual CLI acceptance: a mistyped limiter parity request must
// never silently execute a green non-strict test against real Express.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const flag = '--require-key-parity';
assert.equal(parseStrictAcceptanceArgs([], flag), false);
assert.equal(parseStrictAcceptanceArgs([flag], flag), true);
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)),
  'zbrowse.rate-limit-identity-parity.test.mjs');
for (const invalid of [
  ['--require-key-pariy'],
  ['--require-key-parity=true'],
  ['--require-key-parity', '--require-key-parity'],
  ['--require-key-parity', '--unknown'],
  ['--unknown'],
  ['']
]) {
  assert.throws(() => parseStrictAcceptanceArgs(invalid, flag),
    /Invalid strict acceptance arguments/);
  const child = spawnSync(process.execPath, [entry, ...invalid], {
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(child.status, 1,
    JSON.stringify(invalid) + ': strict CLI must reject unsupported arguments');
  assert.match(child.stderr, /Invalid strict acceptance arguments/,
    'actual production limiter QA script must use the reviewed parser');
  assert.doesNotMatch(child.stdout, /Real Express|strict key parity/,
    'bad option must never show baseline or strict acceptance evidence');
}
console.log('Actual Express rate-limit strict CLI rejects typo/duplicate arguments');
