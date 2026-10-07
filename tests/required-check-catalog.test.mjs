import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, '.github', 'required-checks.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

assert.equal(catalog.version, 1, 'required-check catalog version must be 1');
assert.ok(Array.isArray(catalog.checks), 'required-check catalog must contain a checks array');
assert.ok(catalog.checks.length > 0, 'required-check catalog must not be empty');

const workflows = new Set();
const checkNames = new Set();

function eventBlock(source, eventName) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${eventName}:`);
  if (start === -1) return null;

  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_-]+:/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

for (const entry of catalog.checks) {
  assert.equal(
    Object.keys(entry).sort().join(','),
    'check,workflow',
    'each required-check entry must contain only check and workflow'
  );
  assert.match(entry.workflow, /^\.github\/workflows\/[^/]+\.ya?ml$/);
  assert.equal(typeof entry.check, 'string');
  assert.ok(entry.check.trim().length > 0, 'required check names must be non-empty');
  assert.ok(!workflows.has(entry.workflow), `${entry.workflow} appears more than once in the catalog`);
  assert.ok(!checkNames.has(entry.check), `${entry.check} appears more than once in the catalog`);
  workflows.add(entry.workflow);
  checkNames.add(entry.check);

  const workflowPath = path.join(root, entry.workflow);
  assert.ok(fs.existsSync(workflowPath), `${entry.workflow} must exist`);
  const source = fs.readFileSync(workflowPath, 'utf8');

  const pullRequest = eventBlock(source, 'pull_request');
  assert.notEqual(pullRequest, null, `${entry.workflow} must run on pull_request`);
  assert.doesNotMatch(
    pullRequest,
    /^\s{4}(?:paths|paths-ignore|branches|branches-ignore):/m,
    `${entry.workflow} must run on every pull request before it can be required`
  );

  const jobsSource = source.split(/^jobs:\s*$/m)[1] ?? '';
  const escaped = entry.check.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const jobNameMatches = jobsSource.match(new RegExp(`^\\s{4}name:\\s*${escaped}\\s*$`, 'gm')) ?? [];
  assert.equal(
    jobNameMatches.length,
    1,
    `${entry.check} must match exactly one job display name in ${entry.workflow}`
  );
}

const sorted = [...catalog.checks].sort((a, b) => a.check.localeCompare(b.check));
assert.deepEqual(
  catalog.checks,
  sorted,
  'required-check catalog entries must stay sorted by check name'
);

console.log(`Required-check catalog contract passed for ${catalog.checks.length} always-on PR checks`);
