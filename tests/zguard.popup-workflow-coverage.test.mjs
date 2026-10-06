import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/popup-accessibility-validation.yml', import.meta.url),
  'utf8'
);

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
    workflow.includes(`- "${path}"`),
    `popup accessibility workflow must trigger on ${path}`
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
