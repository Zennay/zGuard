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

const archiveSuffixes = [
  '.7z',
  '.bz2',
  '.gz',
  '.rar',
  '.tar',
  '.tar.bz2',
  '.tar.gz',
  '.tar.xz',
  '.tbz',
  '.tbz2',
  '.tgz',
  '.txz',
  '.xz',
  '.zip'
];

function isArchiveArtifact(relative) {
  const base = path.posix.basename(relative.replaceAll('\\', '/')).toLowerCase();
  return archiveSuffixes.some((suffix) => base.endsWith(suffix));
}

for (const sample of [
  'release.zip',
  'bundle.TAR.GZ',
  'backup.tgz',
  'vendor/archive.7Z',
  'cache/data.xz'
]) {
  assert.equal(isArchiveArtifact(sample), true, `archive artifact self-test must reject ${sample}`);
}

for (const sample of [
  'README.md',
  'public/icon.png',
  'scripts/archive.sh',
  'docs/zip-format.md'
]) {
  assert.equal(isArchiveArtifact(sample), false, `ordinary source/asset self-test must allow ${sample}`);
}

const findings = tracked
  .filter(isArchiveArtifact)
  .map((relative) => `${relative}: tracked archive/bundle artifact`);

assert.deepEqual(
  findings,
  [],
  [
    'tracked repository paths must not contain archive/bundle artifacts',
    ...findings.map((finding) => `- ${finding}`),
    'Keep source reviewable as ordinary tracked files and create distributable archives in CI/release jobs.'
  ].join('\n')
);

console.log(
  `Repository archive-artifact hygiene contract passed for ${tracked.length} tracked files`
);
