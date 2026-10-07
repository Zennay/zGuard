import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workflowDir = path.join(root, '.github', 'workflows');

const workflows = fs.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

assert.ok(workflows.length > 0, 'at least one workflow must be present');

const untrustedExpression = /\$\{\{\s*github\.(?:event(?:\.|\s*\}\})|head_ref\b|base_ref\b|ref_name\b|actor\b)/;

function runScripts(source) {
  const lines = source.split(/\r?\n/);
  const scripts = [];

  for (let i = 0; i < lines.length; i += 1) {
    const blockMatch = lines[i].match(/^(\s*)run:\s*[|>][+-]?\s*(?:#.*)?$/);
    if (blockMatch) {
      const indent = blockMatch[1].length;
      const block = [];

      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() === '') {
          block.push(line);
          continue;
        }

        const leading = line.match(/^\s*/)?.[0].length ?? 0;
        if (leading <= indent) break;
        block.push(line);
      }

      scripts.push(block.join('\n'));
      continue;
    }

    const inlineMatch = lines[i].match(/^\s*run:\s*(.+?)\s*$/);
    if (inlineMatch) {
      scripts.push(inlineMatch[1]);
    }
  }

  return scripts;
}

const selfTestSource = [
  'steps:',
  '  - run: echo "${{ github.actor }}"',
  '  - run: >',
  '      echo "${{ github.event.pull_request.title }}"',
  '  - run: |',
  '      echo "${{ github.head_ref }}"',
  '  - run: echo "$SAFE_VALUE"',
].join('\n');

const selfTestScripts = runScripts(selfTestSource);
assert.equal(selfTestScripts.length, 4, 'run-script extractor must cover inline and block scalar forms');
assert.equal(
  selfTestScripts.filter((script) => untrustedExpression.test(script)).length,
  3,
  'self-test must identify untrusted expressions in inline, folded, and literal run forms'
);

for (const workflow of workflows) {
  const source = fs.readFileSync(path.join(workflowDir, workflow), 'utf8');

  for (const script of runScripts(source)) {
    assert.doesNotMatch(
      script,
      untrustedExpression,
      `${workflow} must not interpolate untrusted github context directly inside shell run commands; pass reviewed values through env instead`
    );
  }

  assert.doesNotMatch(
    source,
    /pull_request_target\s*:/,
    `${workflow} must not use pull_request_target for repository validation`
  );
}

console.log(`Workflow expression safety contract passed for ${workflows.length} workflows`);
