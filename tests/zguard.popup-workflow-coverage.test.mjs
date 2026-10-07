import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/popup-accessibility-validation.yml', import.meta.url),
  'utf8'
);

function eventPaths(source, eventName) {
  const lines = source.split(/\r?\n/);
  const eventStart = lines.findIndex((line) => line === `  ${eventName}:`);
  assert.notEqual(eventStart, -1, `workflow must define ${eventName}`);

  let pathsStart = -1;
  for (let index = eventStart + 1; index < lines.length; index += 1) {
    if (/^  \S/.test(lines[index])) break;
    if (lines[index] === '    paths:') {
      pathsStart = index;
      break;
    }
  }
  assert.notEqual(pathsStart, -1, `${eventName} must define a paths filter`);

  const paths = [];
  for (let index = pathsStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^    \S/.test(line) || /^  \S/.test(line)) break;
    const match = line.match(/^      - ["']([^"']+)["']\s*$/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

const eventPathFixture = [
  'on:',
  '  pull_request:',
  '    paths:',
  '      - "pull-only"',
  '  push:',
  '    paths:',
  '      - "push-only"',
].join('\n');
assert.deepEqual(eventPaths(eventPathFixture, 'pull_request'), ['pull-only']);
assert.deepEqual(eventPaths(eventPathFixture, 'push'), ['push-only']);

const pullRequestPaths = new Set(eventPaths(workflow, 'pull_request'));
const pushPaths = new Set(eventPaths(workflow, 'push'));

const requiredPaths = [
  'chromium/popup.html',
  'chromium/popup.css',
  'chromium/popup.js',
  'chromium/popup-a11y.js',
  'firefox/popup.html',
  'firefox/popup.css',
  'firefox/popup.js',
  'firefox/popup-a11y.js',
  'zbrowse/browser/zguard/popup.html',
  'zbrowse/browser/zguard/popup.css',
  'zbrowse/browser/zguard/popup.js',
  'zbrowse/browser/zguard/popup-a11y.js',
  'tests/zguard.popup-accessibility.test.mjs',
  'tests/zguard.popup-a11y-runtime.test.js',
  'tests/zguard.popup-workflow-coverage.test.mjs',
  '.github/workflows/popup-accessibility-validation.yml',
];

for (const path of requiredPaths) {
  assert.ok(
    pullRequestPaths.has(path),
    `popup accessibility pull_request workflow must trigger on ${path}`
  );
  assert.ok(
    pushPaths.has(path),
    `popup accessibility push workflow must trigger on ${path}`
  );
}

for (const command of [
  'node tests/zguard.popup-accessibility.test.mjs',
  'node tests/zguard.popup-a11y-runtime.test.js',
  'node tests/zguard.popup-workflow-coverage.test.mjs',
]) {
  assert.ok(
    workflow.includes(command),
    `popup accessibility workflow must execute: ${command}`
  );
}

console.log('zGuard popup accessibility workflow coverage passed');
