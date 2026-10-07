import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean);

const javascriptFiles = tracked
  .filter((file) => /\.(?:cjs|mjs|js)$/.test(file))
  .sort();

assert.ok(javascriptFiles.length > 0, 'at least one tracked JavaScript file must be discovered');

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(
    result.status,
    0,
    `${file} must pass node --check:\n${result.stderr || result.stdout}`
  );
}

console.log(`Repository JavaScript syntax contract passed for ${javascriptFiles.length} tracked files`);
