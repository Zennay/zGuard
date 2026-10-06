import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/browser-image-integrity-validation.yml', import.meta.url),
  'utf8'
);

for (const path of [
  'zbrowse/browser/Dockerfile',
  'zbrowse/browser/root/**',
  'tests/zbrowse.base-provenance.test.mjs',
  'tests/zbrowse.contract.test.js',
  'tests/zbrowse.browser-image-workflow.test.mjs',
  '.github/workflows/browser-image-integrity-validation.yml',
]) {
  assert.ok(
    workflow.includes(`- "${path}"`),
    `browser image workflow must trigger on ${path}`
  );
}

for (const command of [
  'node tests/zbrowse.base-provenance.test.mjs',
  'node tests/zbrowse.contract.test.js',
  'bash -n zbrowse/browser/root/usr/local/bin/start-zbrowse',
  'node tests/zbrowse.browser-image-workflow.test.mjs',
]) {
  assert.ok(
    workflow.includes(command),
    `browser image workflow must execute: ${command}`
  );
}

console.log('zBrowse browser image workflow coverage passed');
