import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github', 'workflows');
const MAX_TIMEOUT_MINUTES = 30;

function discoverLocalJobs(source, relative) {
  const lines = source.split(/\r?\n/);
  const jobsIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^jobs:\s*(?:#.*)?$/.test(line))
    .map(({ index }) => index);

  assert.equal(
    jobsIndexes.length,
    1,
    `${relative} must define exactly one top-level jobs block`
  );

  const jobs = [];
  const start = jobsIndexes[0] + 1;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;

    const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (!jobMatch) continue;

    const jobId = jobMatch[1];
    const block = [];

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (/^\S/.test(candidate)) break;
      if (/^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(candidate)) break;
      block.push(candidate);
    }

    if (block.some((candidate) => /^    runs-on:\s*(?:\S.*)?$/.test(candidate))) {
      jobs.push({ jobId, block });
    }
  }

  return jobs;
}

const fixtures = [
  [
    'jobs:\n  validate:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps: []\n',
    [{ jobId: 'validate', timeout: 5 }]
  ],
  [
    'jobs:\n  validate:\n    runs-on:\n      - self-hosted\n      - zcloud\n      - vps\n    timeout-minutes: 5\n    steps: []\n',
    [{ jobId: 'validate', timeout: 5 }]
  ],
  [
    'jobs:\n  call-reusable:\n    uses: owner/repo/.github/workflows/reusable.yml@0123456789012345678901234567890123456789\n',
    []
  ]
];

for (const [fixture, expected] of fixtures) {
  const jobs = discoverLocalJobs(fixture, 'fixture.yml').map(({ jobId, block }) => {
    const match = block.find((line) => /^    timeout-minutes:\s*\d+\s*(?:#.*)?$/.test(line));
    return { jobId, timeout: match ? Number(match.match(/\d+/)?.[0]) : null };
  });
  assert.deepEqual(jobs, expected, 'workflow job discovery self-test must remain stable');
}

const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

assert.ok(workflows.length > 0, 'at least one workflow must be discovered');

let localJobCount = 0;

for (const name of workflows) {
  const relative = path.posix.join('.github', 'workflows', name);
  const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
  const jobs = discoverLocalJobs(source, relative);

  // Reusable-workflow call jobs use `uses:` and do not support `timeout-minutes`
  // at the caller job level, so this contract deliberately targets local runners.
  for (const { jobId, block } of jobs) {
    localJobCount += 1;
    const timeoutLines = block.filter((line) => /^    timeout-minutes:\s*/.test(line));

    assert.equal(
      timeoutLines.length,
      1,
      `${relative} job ${jobId} must define exactly one timeout-minutes value`
    );

    const match = timeoutLines[0].match(
      /^    timeout-minutes:\s*([1-9][0-9]*)\s*(?:#.*)?$/
    );

    assert.ok(
      match,
      `${relative} job ${jobId} timeout-minutes must be a literal positive integer`
    );

    const timeout = Number(match[1]);
    assert.ok(
      timeout <= MAX_TIMEOUT_MINUTES,
      `${relative} job ${jobId} timeout-minutes must be <= ${MAX_TIMEOUT_MINUTES}; got ${timeout}`
    );
  }
}

assert.ok(localJobCount > 0, 'at least one local workflow job must be validated');
console.log(
  `Workflow job timeout contract passed for ${localJobCount} local jobs across ${workflows.length} workflows`
);
