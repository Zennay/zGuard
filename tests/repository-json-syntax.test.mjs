import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const trackedJson = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter((file) => file.endsWith('.json')).sort();

assert.ok(trackedJson.length > 0, 'at least one tracked JSON file must be discovered');

for (const file of trackedJson) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');

  try {
    JSON.parse(source);
  } catch (error) {
    assert.fail(`${file} must contain strict JSON: ${error.message}`);
  }
}

console.log(`Repository JSON syntax contract passed for ${trackedJson.length} tracked JSON files`);
