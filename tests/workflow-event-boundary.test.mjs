import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github', 'workflows');
const allowedEvents = new Set(['pull_request', 'push', 'workflow_dispatch']);
const requiredAutomaticEvents = ['pull_request', 'push'];

// A manually dispatched validation is not a substitute for PR and main-push
// checks: removing an automatic trigger must never make CI silently disappear.
function requireAutomaticValidation(events) {
  for (const required of requiredAutomaticEvents) {
    assert.ok(events.includes(required),
      'workflow must retain automatic ' + required + ' validation');
  }
}

function requireMainPush(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => /^  push:\s*(?:#.*)?$/.test(line));
  assert.ok(start >= 0, 'workflow must retain a block-style push event');
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !/^\s*#/.test(line) && !/^   /.test(line)) break;
    end++;
  }
  const block = lines.slice(start + 1, end);
  const branches = block.findIndex(line => /^    branches:\s*(?:#.*)?$/.test(line));
  assert.ok(branches >= 0, 'push validation must specify main branch');
  let main = false;
  for (let i = branches + 1; i < block.length; i++) {
    const line = block[i];
    if (line.trim() && !/^\s*#/.test(line) && !/^     /.test(line)) break;
    if (/^      - (['"]?)main\1\s*(?:#.*)?$/.test(line)) main = true;
  }
  assert.ok(main, 'push validation must include main, not only other branches/tags');
}

// Repository QA permits deliberately scoped workflow checks, but never
// asymmetric PR/push scopes, skipped workflow-definition changes, or filters
// that select only closed PRs or exclude particular paths.
function requireReviewedAutomaticFilters(source, relative) {
  const lines = source.split(/\r?\n/);
  function fields(event) {
    const start = lines.findIndex(line => line === '  ' + event + ':');
    assert.ok(start >= 0, relative + ': missing block-style ' + event);
    const result = new Map();
    let active = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (!/^    /.test(line)) break;
      const field = /^    ([a-z-]+):\s*(?:#.*)?$/.exec(line);
      if (field) {
        assert.ok(!result.has(field[1]), relative + ': duplicate ' + event + ' field');
        result.set(field[1], []);
        active = field[1];
        continue;
      }
      const item = /^      - (['"]?)([^'"]+)\1\s*(?:#.*)?$/.exec(line);
      assert.ok(item && active, relative + ': unreviewed ' + event + ' YAML');
      result.get(active).push(item[2]);
    }
    return result;
  }
  const pr = fields('pull_request');
  const push = fields('push');
  for (const key of pr.keys()) {
    assert.equal(key, 'paths', relative + ': PR event may only use explicit paths');
  }
  for (const key of push.keys()) {
    assert.ok(key === 'branches' || key === 'paths',
      relative + ': push event may only use reviewed branches/paths');
  }
  assert.deepEqual(push.get('branches'), ['main'],
    relative + ': push must target exactly the main branch');
  assert.equal(pr.has('paths'), push.has('paths'),
    relative + ': filtered PR and push events must be symmetric');
  if (pr.has('paths')) {
    const prPaths = pr.get('paths');
    const pushPaths = push.get('paths');
    assert.ok(prPaths.length > 0, relative + ': filtered workflow needs paths');
    assert.deepEqual(prPaths, pushPaths,
      relative + ': PR/push path filters must match exactly');
    for (const pattern of prPaths) {
      assert.ok(!pattern.startsWith('!') && !pattern.includes('..'),
        relative + ': no negative/parent path filters');
    }
    const ownPath = '.github/workflows/' + relative;
    assert.ok(prPaths.includes(ownPath) ||
      prPaths.includes('.github/workflows/**'),
      relative + ': scoped workflow must re-run when its YAML changes');
  }
}

function workflowEvents(source) {
  const lines = source.split(/\r?\n/);
  const onIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^on:\s*(?:#.*)?$/.test(line))
    .map(({ index }) => index);

  assert.equal(onIndexes.length, 1, 'workflow must define exactly one top-level block-style on: section');

  const events = [];
  for (let index = onIndexes[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;

    const match = line.match(/^  (['"]?)([A-Za-z0-9_-]+)\1:\s*(?:#.*)?$/);
    if (match) events.push(match[2]);
  }

  assert.ok(events.length > 0, 'workflow on: section must contain at least one explicit event');
  return events;
}

const safeFixture = [
  'on:',
  '  pull_request:',
  '    paths:',
  '      - "tests/**"',
  '  "push":',
  '    branches:',
  '      - main',
  "  'workflow_dispatch':",
  '',
  'permissions:',
  '  contents: read',
].join('\n');

assert.deepEqual(
  workflowEvents(safeFixture),
  ['pull_request', 'push', 'workflow_dispatch'],
  'event parser must capture plain or quoted direct children of the on: block only'
);

for (const event of ['pull_request_target', 'workflow_run', 'issue_comment', 'repository_dispatch']) {
  for (const quote of ['', '"', "'"]) {
    const key = quote ? `${quote}${event}${quote}` : event;
    const fixture = ['on:', `  ${key}:`, 'jobs:', '  validate:'].join('\n');
    const disallowed = workflowEvents(fixture).filter((name) => !allowedEvents.has(name));
    assert.deepEqual(
      disallowed,
      [event],
      `self-test must reject ${quote ? 'quoted ' : ''}privileged or indirect trigger ${event}`
    );
  }
}

for (const [name, events] of [
  ['manual-only', ['workflow_dispatch']],
  ['PR-only', ['pull_request']],
  ['push-only', ['push']]
]) {
  assert.throws(() => requireAutomaticValidation(events),
    /workflow must retain automatic/, name + ' trigger downgrade must fail');
}
requireAutomaticValidation(['pull_request', 'push']);
requireAutomaticValidation(['workflow_dispatch', 'push', 'pull_request']);

const validPushFixture = [
  'on:', '  pull_request:', '  push:', '    branches:',
  '      - main', '  workflow_dispatch:', 'jobs:'
].join('\n');
requireMainPush(validPushFixture);
for (const [label, weakened] of [
  ['different branch', validPushFixture.replace('      - main', '      - develop')],
  ['tag only', validPushFixture.replace('    branches:', '    tags:')],
  ['missing branch selector', validPushFixture.replace('    branches:\n      - main\n', '')],
  ['push disabled', validPushFixture.replace('  push:', '  workflow_dispatch:')]
]) {
  assert.throws(() => requireMainPush(weakened), /push validation|block-style push/,
    label + ' must not silently bypass main push validation');
}

const reviewedFilterFixture = [
  'on:', '  pull_request:', '  push:', '    branches:', '      - main',
  '  workflow_dispatch:', 'jobs:'
].join('\n');
requireReviewedAutomaticFilters(reviewedFilterFixture, 'example.yml');
const filteredFixture = reviewedFilterFixture
  .replace('  pull_request:', '  pull_request:\n    paths:\n      - ".github/workflows/example.yml"\n      - "tests/**"')
  .replace('      - main', '      - main\n    paths:\n      - ".github/workflows/example.yml"\n      - "tests/**"');
requireReviewedAutomaticFilters(filteredFixture, 'example.yml');
for (const [label, mutated] of [
  ['PR closed-only', reviewedFilterFixture.replace('  pull_request:',
    '  pull_request:\n    types:\n      - closed')],
  ['PR branch filter', reviewedFilterFixture.replace('  pull_request:',
    '  pull_request:\n    branches:\n      - main')],
  ['PR-only filter', filteredFixture.replace(
    '    paths:\n      - ".github/workflows/example.yml"\n      - "tests/**"\n  workflow_dispatch:', '  workflow_dispatch:')],
  ['push-only filter', reviewedFilterFixture.replace('      - main',
    '      - main\n    paths:\n      - tests/**')],
  ['PR/push filter drift', filteredFixture.replace(
    '      - "tests/**"\n  workflow_dispatch:', '      - "docs/**"\n  workflow_dispatch:')],
  ['untracked workflow edit', filteredFixture.replaceAll(
    '.github/workflows/example.yml', 'src/**')],
  ['excluded security paths', filteredFixture.replace(
    '      - "tests/**"', '      - "!tests/security/**"')],
  ['extra push branch', reviewedFilterFixture.replace('      - main',
    '      - main\n      - feature')],
  ['push tags', reviewedFilterFixture.replace('      - main',
    '      - main\n    tags:\n      - v*')]
]) {
  assert.throws(() => requireReviewedAutomaticFilters(mutated, 'example.yml'),
    undefined, label + ' must not skip a reviewed automatic QA surface');
}

const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

assert.ok(workflows.length > 0, 'at least one workflow must be present');

for (const name of workflows) {
  const relative = path.posix.join('.github', 'workflows', name);
  const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
  const events = workflowEvents(source);
  requireAutomaticValidation(events);
  requireMainPush(source);
  requireReviewedAutomaticFilters(source, name);
  const disallowed = [...new Set(events.filter((event) => !allowedEvents.has(event)))]
    .sort();

  assert.deepEqual(
    disallowed,
    [],
    [
      `${relative} must use only reviewed repository-validation events`,
      `allowed: ${[...allowedEvents].sort().join(', ')}`,
      ...disallowed.map((event) => `disallowed: ${event}`)
    ].join('\n')
  );
}

console.log(`Workflow event boundary passed for ${workflows.length} workflows`);
