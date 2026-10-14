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

// A catalogued name is not sufficient: GitHub can report a green or skipped
// check while the supposed required job checks out the wrong revision, runs
// conditionally, or discards test failures. Bind those properties explicitly.
function verifyRequiredJob(entry, workflowSource) {
  const jobs = workflowSource.split(/^jobs:\s*$/m)[1] ?? '';
  const boundaries = [...jobs.matchAll(/^  ([A-Za-z][A-Za-z0-9_-]*):\s*$/gm)];
  const blocks = boundaries.map((match, index) =>
    jobs.slice(match.index, boundaries[index + 1]?.index ?? jobs.length));
  const selected = blocks.filter(block =>
    block.split('\n').some(line => line.trim() === 'name: ' + entry.check));
  assert.equal(selected.length, 1, entry.check + ': expected exactly one named required job');
  const job = selected[0];
  assert.doesNotMatch(job, /^    (?:if|needs|continue-on-error):/m,
    entry.check + ': required job must execute unconditionally');
  assert.doesNotMatch(job, /^\s+continue-on-error:\s*true\s*$/m,
    entry.check + ': required job may not swallow failing steps');
  assert.match(job, /^    runs-on:\s*ubuntu-(?:latest|24\.04)\s*$/m,
    entry.check + ': required job must use an ephemeral hosted runner');
  assert.match(job, /^        uses: actions\/checkout@[a-f0-9]{40}\b/m,
    entry.check + ': required check must use a pinned checkout action');
  assert.match(job, /^          persist-credentials: false\s*$/m,
    entry.check + ': checkout must not retain GitHub token');
  assert.ok(job.includes('ref: ' + '
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
  verifyRequiredJob(entry, source);

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

// Negative controls ensure the contract detects material green-by-skip
// regressions, rather than only finding currently healthy metadata.
const sample = catalog.checks[0];
const original = fs.readFileSync(path.join(root, sample.workflow), 'utf8');
const mutate = (label, replacement) => {
  assert.notEqual(replacement, original, label + ': mutation must alter a job');
  assert.throws(() => verifyRequiredJob(sample, replacement),
    undefined, label + ': required job integrity must fail closed');
};
mutate('conditional required check',
  original.replace('    runs-on: ubuntu-latest',
    '    if: false\n    runs-on: ubuntu-latest'));
mutate('ignorable required check failure',
  original.replace('    timeout-minutes: 5',
    '    timeout-minutes: 5\n    continue-on-error: true'));
mutate('checkout default branch instead of PR revision',
  original.replace('ref: ' + '
 +
    '{{ github.event.pull_request.head.sha || github.sha }}'),
  entry.check + ': checkout must use exact proposed PR SHA');
  assert.ok(job.includes('EXPECTED_SHA: ' + '
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
 +
    '{{ github.event.pull_request.head.sha || github.sha }}'),
  entry.check + ': expected SHA must come from the event');
  assert.ok(job.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'),
    entry.check + ': checkout revision must be verified before tests');
  return true;
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
 +
    '{{ github.event.pull_request.head.sha || github.sha }}',
    'ref: main'));
mutate('skip checkout revision proof',
  original.replace('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
    'echo unchecked'));

console.log(`Required-check catalog contract passed for ${catalog.checks.length} always-on, exact-head PR checks and 4 negative mutation proofs`);
 +
    '{{ github.event.pull_request.head.sha || github.sha }}'),
  entry.check + ': checkout must use exact proposed PR SHA');
  assert.ok(job.includes('EXPECTED_SHA: ' + '
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
 +
    '{{ github.event.pull_request.head.sha || github.sha }}'),
  entry.check + ': expected SHA must come from the event');
  assert.ok(job.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'),
    entry.check + ': checkout revision must be verified before tests');
  return true;
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
