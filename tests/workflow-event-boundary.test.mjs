import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github', 'workflows');
const allowedEvents = new Set(['pull_request', 'push', 'workflow_dispatch']);

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

const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

assert.ok(workflows.length > 0, 'at least one workflow must be present');

for (const name of workflows) {
  const relative = path.posix.join('.github', 'workflows', name);
  const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
  const events = workflowEvents(source);
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
