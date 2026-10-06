import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function writeExecutable(file, body) {
  writeFileSync(file, body, 'utf8');
  chmodSync(file, 0o755);
}

function prepareFixture({ dockerShim = null, envContent = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'zbrowse-install-preflight-'));
  const project = path.join(root, 'zbrowse');
  const scripts = path.join(project, 'scripts');
  const bin = path.join(root, 'bin');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });

  copyFileSync(path.join(repoRoot, 'zbrowse/scripts/install.sh'), path.join(scripts, 'install.sh'));
  copyFileSync(path.join(repoRoot, 'zbrowse/.env.example'), path.join(project, '.env.example'));

  writeExecutable(path.join(bin, 'dirname'), '#!/bin/sh\nexec /usr/bin/dirname "$@"\n');
  writeExecutable(path.join(bin, 'cp'), '#!/bin/sh\nexec /bin/cp "$@"\n');
  if (dockerShim !== null) {
    writeExecutable(path.join(bin, 'docker'), dockerShim);
  }
  if (envContent !== null) {
    writeFileSync(path.join(project, '.env'), envContent, 'utf8');
  }

  return { root, project, bin, installer: path.join(scripts, 'install.sh') };
}

function runFixture(fixture) {
  return spawnSync('/bin/bash', [fixture.installer], {
    cwd: fixture.project,
    env: { ...process.env, PATH: fixture.bin },
    encoding: 'utf8'
  });
}

{
  const fixture = prepareFixture();
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0, 'installer must fail without Docker');
    assert.match(result.stderr, /Docker Engine is required\./);
    assert.equal(
      existsSync(path.join(fixture.project, '.env')),
      false,
      'missing Docker must not materialize .env'
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = prepareFixture({
    dockerShim: '#!/bin/sh\nexit 1\n'
  });
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0, 'installer must fail without Docker Compose v2');
    assert.match(result.stderr, /Docker Compose v2 is required\./);
    assert.equal(
      existsSync(path.join(fixture.project, '.env')),
      false,
      'missing Compose v2 must not materialize .env'
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const original = 'PORT=9000\nDOCKER_GID=123\n';
  const fixture = prepareFixture({
    dockerShim: '#!/bin/sh\nexit 1\n',
    envContent: original
  });
  try {
    runFixture(fixture);
    assert.equal(
      readFileSync(path.join(fixture.project, '.env'), 'utf8'),
      original,
      'failed prerequisite checks must not mutate an existing .env'
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

console.log('zBrowse installer preflight mutation contract passed');
