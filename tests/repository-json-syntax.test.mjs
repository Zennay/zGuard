import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function isJsonPath(file) {
  return path.extname(file).toLowerCase() === '.json';
}

assert.ok(isJsonPath('fixture.json'), 'lowercase JSON discovery self-test must pass');
assert.ok(isJsonPath('fixture.JSON'), 'casefold JSON discovery self-test must pass');
assert.ok(!isJsonPath('fixture.json.txt'), 'non-JSON discovery self-test must stay excluded');

const trackedJson = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(isJsonPath).sort();

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
