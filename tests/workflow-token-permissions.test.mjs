import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github', 'workflows');
const secretReference = /\$\{\{[^}]*\bsecrets\b[^}]*\}\}/i;

assert.match('${{ secrets.API_KEY }}', secretReference);
assert.match("${{ secrets['API_KEY'] }}", secretReference);
assert.match('${{ toJSON(secrets) }}', secretReference);
assert.doesNotMatch('${{ github.ref }}', secretReference);

const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

assert.ok(workflows.length > 0, 'at least one workflow must be discovered');

for (const name of workflows) {
  const relative = path.posix.join('.github', 'workflows', name);
  const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
  const lines = source.split(/\r?\n/);

  const topLevelPermissionIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^permissions:\s*(?:#.*)?$/.test(line))
    .map(({ index }) => index);

  assert.equal(
    topLevelPermissionIndexes.length,
    1,
    `${relative} must define exactly one explicit top-level permissions block`
  );

  const start = topLevelPermissionIndexes[0] + 1;
  const entries = [];

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;

    const match = line.match(/^  ([A-Za-z-]+):\s*([^#\s]+)\s*(?:#.*)?$/);
    assert.ok(match, `${relative} has malformed or nested top-level token permission: ${line.trim()}`);
    entries.push([match[1], match[2]]);
  }

  assert.deepEqual(
    entries,
    [['contents', 'read']],
    `${relative} must grant only contents: read to the workflow token`
  );

  const nestedPermissionLines = lines.filter((line) => /^\s+permissions\s*:/.test(line));
  assert.deepEqual(
    nestedPermissionLines,
    [],
    `${relative} must not override token permissions at job level`
  );

  assert.doesNotMatch(
    source,
    /^\s*permissions:\s*(?:write-all|read-all|\{\s*\})\s*(?:#.*)?$/m,
    `${relative} must use the explicit least-privilege permissions block`
  );
  assert.doesNotMatch(
    source,
    /^\s*[A-Za-z-]+:\s*write\s*(?:#.*)?$/m,
    `${relative} must not grant write-scoped workflow token permissions`
  );
  assert.doesNotMatch(
    source,
    /^\s*secrets:\s*inherit\s*(?:#.*)?$/m,
    `${relative} must not inherit all caller secrets`
  );
  assert.doesNotMatch(
    source,
    secretReference,
    `${relative} validation workflows must not read repository or environment secrets`
  );
}

console.log(`Workflow token/secret boundary passed for ${workflows.length} workflows`);
