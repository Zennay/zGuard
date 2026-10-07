import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const checkoutSha = 'df4cb1c069e1874edd31b4311f1884172cec0e10';

const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .map((name) => ({
    relative: path.posix.join('.github', 'workflows', name),
    source: fs.readFileSync(path.join(workflowDir, name), 'utf8')
  }))
  .filter(({ source }) => /runs-on:\s*ubuntu-latest/.test(source))
  .sort((a, b) => a.relative.localeCompare(b.relative));

assert.ok(workflows.length > 0, 'at least one portable hosted workflow must be discovered');

for (const { relative: workflow, source } of workflows) {
  const matches = [...source.matchAll(/uses:\s*actions\/checkout@([^\s#]+)/g)];

  assert.equal(matches.length, 1, `${workflow} must contain exactly one checkout action`);
  assert.equal(
    matches[0][1],
    checkoutSha,
    `${workflow} must pin checkout v6.0.3 by full commit SHA`
  );
  assert.match(
    source,
    /persist-credentials:\s*false/,
    `${workflow} must not persist checkout credentials`
  );
  assert.match(
    source,
    /permissions:\s*\n\s+contents:\s*read/,
    `${workflow} must keep read-only token permissions`
  );
  assert.match(
    source,
    /timeout-minutes:\s*[1-9][0-9]*/,
    `${workflow} must keep a bounded job timeout`
  );
  assert.match(
    source,
    /workflow_dispatch:\s*(?:\n|$)/,
    `${workflow} must remain manually dispatchable for deterministic re-validation`
  );
  assert.match(
    source,
    /concurrency:\s*\n[\s\S]*?cancel-in-progress:\s*true/,
    `${workflow} must cancel superseded duplicate runs`
  );
  assert.ok(
    source.includes(workflow),
    `${workflow} must trigger when its own workflow definition changes`
  );
}

console.log(`Dedicated workflow integrity contract passed for ${workflows.length} hosted workflows`);
