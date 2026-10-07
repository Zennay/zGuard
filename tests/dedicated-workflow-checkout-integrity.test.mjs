import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const checkoutSha = 'df4cb1c069e1874edd31b4311f1884172cec0e10';
const temporarilyOwnedWorkflow = '.github/workflows/quality-validation.yml';
const requiredChecks = JSON.parse(
  fs.readFileSync(path.join(root, '.github', 'required-checks.json'), 'utf8')
).checks.map(({ workflow }) => workflow);
const prHeadContractWorkflows = new Set(
  requiredChecks.filter((workflow) => workflow !== temporarilyOwnedWorkflow)
);


const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .map((name) => ({
    relative: path.posix.join('.github', 'workflows', name),
    source: fs.readFileSync(path.join(workflowDir, name), 'utf8')
  }))
  .filter(({ source }) => /uses:\s*actions\/checkout@/.test(source))
  .sort((a, b) => a.relative.localeCompare(b.relative));

assert.ok(workflows.length > 0, 'at least one checkout-based workflow must be discovered');

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

  if (prHeadContractWorkflows.has(workflow)) {
    assert.match(
      source,
      /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/,
      `${workflow} must checkout the PR head SHA and fall back to github.sha outside pull_request`
    );
    assert.match(
      source,
      /name:\s*Verify checkout commit[\s\S]*?EXPECTED_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}[\s\S]*?run:\s*test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/,
      `${workflow} must prove the checked-out git HEAD matches the selected PR-head contract`
    );
  }
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
    /push:\s*\n\s+branches:\s*\n\s+- main/,
    `${workflow} must re-validate relevant changes after they land on main`
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

  const hasExplicitSelfPath = source.includes(workflow);
  const hasUnfilteredPullRequest = /^  pull_request:\s*$/m.test(source);
  assert.ok(
    hasExplicitSelfPath || hasUnfilteredPullRequest,
    `${workflow} must trigger when its own workflow definition changes`
  );

  assert.doesNotMatch(
    source,
    /pull_request_target\s*:/,
    `${workflow} must not execute checkout-based validation via pull_request_target`
  );
}

assert.deepEqual(
  [...prHeadContractWorkflows].sort(),
  requiredChecks.filter((workflow) => workflow !== temporarilyOwnedWorkflow).sort(),
  'every required workflow outside the explicitly owned quality-validation lane must use the landed PR-head checkout contract'
);

console.log(
  `Dedicated workflow integrity contract passed for ${workflows.length} checkout workflows; ` +
  `${prHeadContractWorkflows.size} required workflows prove PR-head checkout`
);
