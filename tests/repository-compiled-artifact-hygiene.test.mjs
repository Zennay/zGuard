import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean).sort();

assert.ok(tracked.length > 0, 'repository must contain tracked files');

const compiledExtensions = new Set([
  '.a',
  '.class',
  '.dll',
  '.dylib',
  '.exe',
  '.jar',
  '.lib',
  '.o',
  '.obj',
  '.pdb',
  '.pyc',
  '.pyo',
  '.so',
  '.war'
]);

function isCompiledArtifact(relative) {
  const base = path.posix.basename(relative.replaceAll('\\', '/')).toLowerCase();

  if (base.endsWith('.min.js') || base.endsWith('.min.css')) return false;

  for (const extension of compiledExtensions) {
    if (base.endsWith(extension)) return true;
  }

  return false;
}

for (const sample of [
  'bin/tool.EXE',
  'lib/native.so',
  'build/Object.OBJ',
  'cache/module.PYC',
  'vendor/archive.JAR'
]) {
  assert.equal(isCompiledArtifact(sample), true, `compiled artifact self-test must reject ${sample}`);
}

for (const sample of [
  'chromium/icon.png',
  'src/module.mjs',
  'styles/popup.min.css',
  'public/app.min.js'
]) {
  assert.equal(isCompiledArtifact(sample), false, `ordinary source/asset self-test must allow ${sample}`);
}

const findings = tracked
  .filter(isCompiledArtifact)
  .map((relative) => `${relative}: tracked compiled/binary build artifact`);

assert.deepEqual(
  findings,
  [],
  [
    'tracked repository paths must not contain compiled build artifacts',
    ...findings.map((finding) => `- ${finding}`),
    'Build compiled outputs in CI/runtime stages instead of committing generated binaries.'
  ].join('\n')
);

console.log(
  `Repository compiled-artifact hygiene contract passed for ${tracked.length} tracked files`
);
