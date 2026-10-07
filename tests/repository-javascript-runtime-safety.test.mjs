import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean);

const productionJavaScript = tracked
  .filter((file) => /\.(?:cjs|mjs|js)$/.test(file))
  .filter((file) => !file.startsWith('tests/'))
  .sort();

assert.ok(
  productionJavaScript.length > 0,
  'at least one tracked production JavaScript file must be discovered'
);

const forbidden = [
  { name: 'eval identifier', pattern: /\beval\b/ },
  { name: 'Function constructor identifier', pattern: /\bFunction\b/ },
  { name: 'innerHTML sink', pattern: /\.\s*innerHTML\b/ },
  { name: 'outerHTML sink', pattern: /\.\s*outerHTML\b/ },
  { name: 'insertAdjacentHTML sink', pattern: /\.\s*insertAdjacentHTML\s*\(/ },
  { name: 'document.write sink', pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/ }
];

function violationsFor(source) {
  return forbidden
    .filter(({ pattern }) => pattern.test(source))
    .map(({ name }) => name);
}

for (const [source, expected] of [
  ['console.log("safe");', []],
  ['const evaluation = "safe";', []],
  ['element.textContent = value;', []],
  ['eval("alert(1)")', ['eval identifier']],
  ['(0, eval)("alert(1)")', ['eval identifier']],
  ['window.eval("alert(1)")', ['eval identifier']],
  ['Function("return 1")()', ['Function constructor identifier']],
  ['new Function("return 1")()', ['Function constructor identifier']],
  ['node.innerHTML = html;', ['innerHTML sink']],
  ['node.outerHTML = html;', ['outerHTML sink']],
  ['node.insertAdjacentHTML("beforeend", html);', ['insertAdjacentHTML sink']],
  ['document.write(html);', ['document.write sink']],
  ['document.writeln(html);', ['document.write sink']]
]) {
  assert.deepEqual(
    violationsFor(source),
    expected,
    `runtime-safety detector self-test failed for ${JSON.stringify(source)}`
  );
}

const violations = [];

for (const file of productionJavaScript) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const violation of violationsFor(source)) {
    violations.push(`${file}: ${violation}`);
  }
}

if (violations.length > 0) {
  throw new Error(
    [
      'Production JavaScript must avoid dynamic code generation and raw HTML injection sinks.',
      'Prefer static code paths and DOM APIs such as textContent/createElement instead of eval/Function or HTML-string sinks.',
      ...violations.map((violation) => `- ${violation}`)
    ].join('\n')
  );
}

console.log(
  `Repository JavaScript runtime-safety contract passed for ${productionJavaScript.length} production files`
);
