import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const fullSha = /^[0-9a-f]{40}$/i;

const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

assert.ok(workflows.length > 0, 'at least one workflow must be present');

let externalActions = 0;

for (const workflow of workflows) {
  const source = fs.readFileSync(path.join(workflowDir, workflow), 'utf8');
  const references = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
    .map((match) => match[1]);

  for (const reference of references) {
    if (reference.startsWith('./')) continue;

    if (reference.startsWith('docker://')) {
      assert.match(
        reference,
        /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/i,
        `${workflow} Docker action must use an immutable sha256 digest: ${reference}`
      );
      externalActions += 1;
      continue;
    }

    const at = reference.lastIndexOf('@');
    assert.ok(at > 0, `${workflow} external action must include an immutable ref: ${reference}`);

    const action = reference.slice(0, at);
    const ref = reference.slice(at + 1);

    assert.match(
      action,
      /^[^/\s]+\/[^/\s]+(?:\/[^\s]+)?$/,
      `${workflow} has an invalid external action reference: ${reference}`
    );
    assert.match(
      ref,
      fullSha,
      `${workflow} external action must be pinned by full 40-character commit SHA: ${reference}`
    );

    externalActions += 1;
  }
}

assert.ok(externalActions > 0, 'at least one external action reference must be validated');
console.log(`Workflow action pinning contract passed for ${externalActions} external action references`);
