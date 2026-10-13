// Negative real-CLI probes; never enable the separately unresolved strict
// runtime behavior gate simply to validate argument parsing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)),
  'zguard.content-live-settings.test.mjs');

for (const args of [
  ['--require-live-setting'],
  ['--require-live-settings=true'],
  ['--require-live-settings', '--require-live-settings'],
  ['--require-live-settings', '--unknown'],
  ['--self-test'],
  ['']
]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 1, JSON.stringify(args) + ': malformed strict CLI must fail');
  assert.match(result.stderr, /Unsupported live-settings acceptance arguments/,
    JSON.stringify(args) + ': actual acceptance entrypoint must reject arguments');
  assert.doesNotMatch(result.stdout, /Content script live mode|Initial content script/,
    'invalid arguments must never produce ordinary successful validation output');
}
console.log('Live-settings strict CLI rejection contract passed');
