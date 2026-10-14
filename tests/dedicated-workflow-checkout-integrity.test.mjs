import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const checkoutSha = 'df4cb1c069e1874edd31b4311f1884172cec0e10';
const requiredChecks = JSON.parse(
  fs.readFileSync(path.join(root, '.github', 'required-checks.json'), 'utf8')
).checks.map(({ workflow }) => workflow);
// Extension manifest checks are security-sensitive even when not one of the
// six repository-admin required check contexts. Bind their results to the
// proposed commit rather than GitHub's synthetic PR merge revision.
const additionalSourceBoundWorkflows = [
  '.github/workflows/manifest-integrity-validation.yml',
  '.github/workflows/popup-accessibility-validation.yml',
  '.github/workflows/browser-image-integrity-validation.yml',
  '.github/workflows/zguard-local-resource-integrity.yml'
];
const prHeadContractWorkflows = new Set([
  ...requiredChecks, ...additionalSourceBoundWorkflows
]);


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

assert.ok(requiredChecks.every(file => prHeadContractWorkflows.has(file)),
  'all six required check workflows must remain exact-PR-head bound');
assert.ok(additionalSourceBoundWorkflows.every(file => prHeadContractWorkflows.has(file)),
  'manifest source integrity must remain exact-PR-head bound');
assert.equal(prHeadContractWorkflows.size,
  requiredChecks.length + additionalSourceBoundWorkflows.length,
  'the source-bound contract must not silently lose a protected workflow');

// Canary: the previous checkout-without-ref flow silently validated GitHub's
// synthetic merge ref and still produced a successful status on a PR.
const trustedRef = 'ref: ' + String.fromCharCode(36) +
  '{{ github.event.pull_request.head.sha || github.sha }}';
const checkoutProof = 'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"';
for (const reviewedWorkflow of additionalSourceBoundWorkflows) {
  const selected = workflows.find(({ relative }) => relative === reviewedWorkflow);
  assert.ok(selected, reviewedWorkflow + ': protected QA workflow must be discovered');
  assert.ok(selected.source.includes(trustedRef),
    reviewedWorkflow + ': exact trusted PR-head checkout must be present');
  assert.ok(selected.source.includes(checkoutProof),
    reviewedWorkflow + ': git checkout identity proof must be present');
  for (const [name, changed] of [
    ['implicit merge checkout', selected.source.replace(trustedRef, 'ref: main')],
    ['missing checkout proof', selected.source.replace(checkoutProof, 'echo unverified')]
  ]) {
    assert.notEqual(changed, selected.source,
      reviewedWorkflow + ' ' + name + ': mutation must change source');
    assert.ok(!(changed.includes(trustedRef) && changed.includes(checkoutProof)),
      reviewedWorkflow + ' ' + name + ': unsafe checkout mutation must be detected');
  }
}

console.log(
  `Dedicated workflow integrity contract passed for ${workflows.length} checkout workflows; ` +
  `${prHeadContractWorkflows.size} required workflows prove PR-head checkout`
);
