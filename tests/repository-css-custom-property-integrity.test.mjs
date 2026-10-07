import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const cssFiles = tracked.filter((file) => file.endsWith('.css')).sort();
assert.ok(cssFiles.length > 0, 'repository must contain tracked CSS files');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function findMatchingParen(source, openIndex) {
  let depth = 1;
  let quote = null;

  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index];

    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function hasTopLevelComma(value) {
  let depth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) return true;
  }

  return false;
}

function requiredCustomPropertyReferences(source) {
  const clean = stripComments(source);
  const references = new Set();

  for (let index = 0; index < clean.length; index += 1) {
    const start = clean.indexOf('var(', index);
    if (start === -1) break;

    const end = findMatchingParen(clean, start + 3);
    assert.notEqual(end, -1, 'CSS var() reference must have a closing parenthesis');

    const body = clean.slice(start + 4, end).trim();
    const name = body.match(/^(--[A-Za-z_][A-Za-z0-9_-]*)\b/)?.[1];
    assert.ok(name, `CSS var() must begin with a custom property name: var(${body})`);

    if (!hasTopLevelComma(body)) references.add(name);
    index = end;
  }

  return references;
}

function customPropertyDefinitions(source) {
  const definitions = new Set();
  const clean = stripComments(source);
  for (const match of clean.matchAll(/(?:^|[;{])\s*(--[A-Za-z_][A-Za-z0-9_-]*)\s*:/gm)) {
    definitions.add(match[1]);
  }
  return definitions;
}

function missingRequiredCustomProperties(source) {
  const definitions = customPropertyDefinitions(source);
  return [...requiredCustomPropertyReferences(source)]
    .filter((name) => !definitions.has(name))
    .sort();
}

assert.deepEqual(
  missingRequiredCustomProperties(':root { --accent: red; } .x { color: var(--accent); }'),
  [],
  'custom-property self-test must accept a local definition'
);
assert.deepEqual(
  missingRequiredCustomProperties('.x { color: var(--missing); }'),
  ['--missing'],
  'custom-property self-test must reject an undefined required variable'
);
assert.deepEqual(
  missingRequiredCustomProperties('.x { color: var(--optional, rgb(1, 2, 3)); }'),
  [],
  'custom-property self-test must allow an undefined variable with a fallback'
);
assert.deepEqual(
  missingRequiredCustomProperties(
    ':root { --inner: blue; } .x { color: var(--outer, var(--inner)); }'
  ),
  [],
  'custom-property self-test must keep nested fallback parsing balanced'
);

for (const file of cssFiles) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.deepEqual(
    missingRequiredCustomProperties(source),
    [],
    `${file}: required CSS custom properties must be locally defined or provide a fallback`
  );
}

const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/repository-css-custom-property-integrity.yml'),
  'utf8'
);
assert.match(
  workflow,
  /runs-on:\s*ubuntu-latest/,
  'CSS custom-property validation must use a portable hosted runner'
);
assert.match(
  workflow,
  /permissions:\s*\n\s+contents:\s*read/,
  'CSS custom-property workflow token must remain read-only'
);
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'CSS custom-property checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /node tests\/repository-css-custom-property-integrity\.test\.mjs/,
  'workflow must execute the CSS custom-property integrity contract'
);
assert.ok(
  workflow.includes('- "**/*.css"'),
  'CSS custom-property workflow must trigger for every tracked CSS path'
);
for (const relativePath of [
  'tests/repository-css-custom-property-integrity.test.mjs',
  '.github/workflows/repository-css-custom-property-integrity.yml',
]) {
  assert.ok(
    workflow.includes(`- "${relativePath}"`),
    `CSS custom-property workflow must trigger when ${relativePath} changes`
  );
}

console.log(`CSS custom-property integrity passed for ${cssFiles.length} tracked files`);
