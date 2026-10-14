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
