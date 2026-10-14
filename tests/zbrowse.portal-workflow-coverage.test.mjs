import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/portal-accessibility-validation.yml', import.meta.url),
  'utf8'
);

for (const path of [
  'zbrowse/gateway/public/index.html',
  'zbrowse/gateway/public/styles.css',
  'zbrowse/gateway/public/app.js',
  'tests/zbrowse.portal-accessibility.test.mjs',
  'tests/zbrowse.frontend-session.test.js',
  'tests/zbrowse.read-budget-integrity.test.mjs',
  'tests/zbrowse.session-response-budget.test.mjs',
  'tests/zbrowse.readonly-content-length-real-http.test.mjs',
  'tests/zbrowse.tv-api-redirect-real-http.test.mjs',
  'tests/zbrowse.session-start-liveness-real-http.test.mjs',
  'tests/zbrowse.public-origin-readiness.test.mjs',
  'tests/zbrowse.portal-workflow-coverage.test.mjs',
  '.github/workflows/portal-accessibility-validation.yml',
]) {
  assert.ok(
    workflow.includes(`- "${path}"`),
    `portal accessibility workflow must trigger on ${path}`
  );
}

for (const command of [
  'node tests/zbrowse.portal-accessibility.test.mjs',
  'node tests/zbrowse.frontend-session.test.js',
  'node tests/zbrowse.read-budget-integrity.test.mjs',
  'node tests/zbrowse.session-response-budget.test.mjs',
  'node tests/zbrowse.readonly-content-length-real-http.test.mjs',
  'node tests/zbrowse.tv-api-redirect-real-http.test.mjs',
  'node tests/zbrowse.session-start-liveness-real-http.test.mjs',
  'node tests/zbrowse.portal-workflow-coverage.test.mjs',
]) {
  assert.ok(
    workflow.includes(command),
    `portal accessibility workflow must execute: ${command}`
  );
}

// A green pull_request check is not exact-head evidence unless the source
// checkout and the git workspace HEAD are both tied to the PR head.
const headRepo = 'repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}';
const headRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const expected = 'EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}';
const verify = 'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"';
for (const clause of [headRepo, headRef, expected, verify, 'persist-credentials: false']) {
  assert.ok(workflow.includes(clause), 'portal source provenance must retain: ' + clause);
}
assert.ok(
  workflow.indexOf(headRef) < workflow.indexOf(verify) &&
  workflow.indexOf(verify) < workflow.indexOf('node tests/zbrowse.frontend-session.test.js'),
  'checkout identity must be proved before browser-session regression tests execute'
);
assert.ok(
  /runs-on:\s*ubuntu-latest/.test(workflow),
  'untrusted portal pull requests must run on an ephemeral hosted runner'
);

console.log('zBrowse portal accessibility workflow coverage passed');
