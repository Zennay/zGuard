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

function splitTopLevelCommas(value) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote !== null) {
      current += char;
      if (char === '\\') {
        current += value[index + 1] ?? '';
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);

    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts.filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function validateAnimationReferences(source, label) {
  const clean = stripComments(source);
  const definitions = new Set();

  for (const match of clean.matchAll(/@(?:-webkit-)?keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)\b/g)) {
    definitions.add(match[1]);
  }

  const used = new Set();
  const declarationPattern = /(?:^|[;{])\s*(animation(?:-name)?)\s*:\s*([^;}{]+)/gm;

  for (const match of clean.matchAll(declarationPattern)) {
    const property = match[1];
    const value = match[2].trim();

    for (const segment of splitTopLevelCommas(value)) {
      if (segment === 'none') continue;

      if (property === 'animation-name') {
        assert.match(
          segment,
          /^[A-Za-z_][A-Za-z0-9_-]*$/,
          `${label}: animation-name must use a reviewable literal keyframe name, got "${segment}"`
        );
        assert.ok(
          definitions.has(segment),
          `${label}: animation-name references missing @keyframes "${segment}"`
        );
        used.add(segment);
        continue;
      }

      const matches = [...definitions].filter((name) => (
        new RegExp(`(^|\\s)${escapeRegExp(name)}(?=\\s|$)`).test(segment)
      ));

      assert.equal(
        matches.length,
        1,
        `${label}: animation shorthand must reference exactly one local @keyframes name: "${segment}"`
      );
      used.add(matches[0]);
    }
  }

  const unused = [...definitions].filter((name) => !used.has(name)).sort();
  assert.deepEqual(unused, [], `${label}: @keyframes definitions must be referenced`);
}

assert.doesNotThrow(
  () => validateAnimationReferences(
    '.spinner { animation: spin .8s linear infinite; } @keyframes spin { to { opacity: 0; } }',
    'self-test valid'
  ),
  'animation integrity self-test must accept a referenced local keyframe'
);

assert.doesNotThrow(
  () => validateAnimationReferences(
    '.a { animation: fade 1s steps(2, end), spin .5s linear; } @keyframes fade { to { opacity: 0; } } @keyframes spin { to { transform: rotate(1turn); } }',
    'self-test comma'
  ),
  'animation integrity self-test must split top-level commas without splitting function arguments'
);

assert.throws(
  () => validateAnimationReferences('.spinner { animation: spin .8s linear; }', 'self-test missing'),
  /exactly one local @keyframes name/,
  'animation integrity self-test must reject a missing keyframe definition'
);

assert.throws(
  () => validateAnimationReferences('@keyframes spin { to { opacity: 0; } }', 'self-test unused'),
  /definitions must be referenced/,
  'animation integrity self-test must reject dead keyframe definitions'
);

for (const file of cssFiles) {
  validateAnimationReferences(fs.readFileSync(path.join(root, file), 'utf8'), file);
}

const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/repository-css-animation-integrity.yml'),
  'utf8'
);
assert.match(workflow, /runs-on:\s*ubuntu-latest/, 'CSS animation validation must use a portable hosted runner');
assert.match(
  workflow,
  /permissions:\s*\n\s+contents:\s*read/,
  'CSS animation workflow token must remain read-only'
);
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'CSS animation checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /node tests\/repository-css-animation-integrity\.test\.mjs/,
  'workflow must execute the CSS animation integrity contract'
);
assert.ok(
  workflow.includes('- "**/*.css"'),
  'CSS animation workflow must trigger for every tracked CSS path'
);
for (const relativePath of [
  'tests/repository-css-animation-integrity.test.mjs',
  '.github/workflows/repository-css-animation-integrity.yml',
]) {
  assert.ok(
    workflow.includes(`- "${relativePath}"`),
    `CSS animation workflow must trigger when ${relativePath} changes`
  );
}

console.log(`CSS animation integrity passed for ${cssFiles.length} tracked files`);
