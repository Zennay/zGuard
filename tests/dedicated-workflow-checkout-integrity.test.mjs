import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const checkoutSha = 'df4cb1c069e1874edd31b4311f1884172cec0e10';

const workflows = [
  '.github/workflows/manifest-integrity-validation.yml',
  '.github/workflows/popup-accessibility-validation.yml',
  '.github/workflows/portal-accessibility-validation.yml',
  '.github/workflows/repository-hygiene-validation.yml',
  '.github/workflows/browser-image-integrity-validation.yml',
  '.github/workflows/gateway-containment-validation.yml',
  '.github/workflows/gateway-dependency-audit.yml',
  '.github/workflows/zbrowse-sites-config-safety.yml',
  '.github/workflows/zbrowse-env-compose-parity.yml'
];

for (const workflow of workflows) {
  const source = fs.readFileSync(path.join(root, workflow), 'utf8');
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
    /runs-on:\s*ubuntu-latest/,
    `${workflow} is portable and must not depend on the generic self-hosted queue`
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

console.log('Dedicated workflow checkout integrity contract passed');
