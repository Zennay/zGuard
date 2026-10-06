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
  'node tests/zbrowse.portal-workflow-coverage.test.mjs',
]) {
  assert.ok(
    workflow.includes(command),
    `portal accessibility workflow must execute: ${command}`
  );
}

console.log('zBrowse portal accessibility workflow coverage passed');
