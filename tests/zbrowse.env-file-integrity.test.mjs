import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const helper = path.join(repoRoot, 'zbrowse/scripts/prepare-env.sh');

function run(args) {
  return spawnSync('/bin/bash', [helper, ...args], {
    encoding: 'utf8'
  });
}

function mode(file) {
  return lstatSync(file).mode & 0o777;
}

{
  const root = mkdtempSync(path.join(tmpdir(), 'zbrowse-env-integrity-create-'));
  const envPath = path.join(root, '.env');
  const templatePath = path.join(root, '.env.example');
  try {
    writeFileSync(templatePath, 'PORT=8090\nTRUST_PROXY=1\n', 'utf8');
    chmodSync(templatePath, 0o644);

    const result = run([envPath, templatePath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(envPath, 'utf8'), 'PORT=8090\nTRUST_PROXY=1\n');
    assert.equal(mode(envPath), 0o600, 'new .env must be owner-readable/writable only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(path.join(tmpdir(), 'zbrowse-env-integrity-existing-'));
  const envPath = path.join(root, '.env');
  const templatePath = path.join(root, '.env.example');
  try {
    writeFileSync(templatePath, 'PORT=8090\n', 'utf8');
    writeFileSync(envPath, 'PORT=9000\nCUSTOM=value\n', 'utf8');
    chmodSync(envPath, 0o644);

    const result = run([envPath, templatePath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(envPath, 'utf8'),
      'PORT=9000\nCUSTOM=value\n',
      'existing environment content must not be replaced'
    );
    assert.equal(mode(envPath), 0o600, 'existing .env permissions must be tightened');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(path.join(tmpdir(), 'zbrowse-env-integrity-symlink-'));
  const envPath = path.join(root, '.env');
  const templatePath = path.join(root, '.env.example');
  const targetPath = path.join(root, 'target.env');
  try {
    writeFileSync(templatePath, 'PORT=8090\n', 'utf8');
    writeFileSync(targetPath, 'DO_NOT_TOUCH=yes\n', 'utf8');
    symlinkSync(targetPath, envPath);

    const result = run([envPath, templatePath]);
    assert.notEqual(result.status, 0, 'symlinked .env must be rejected');
    assert.match(result.stderr, /Refusing to use symlinked environment file/);
    assert.equal(
      readFileSync(targetPath, 'utf8'),
      'DO_NOT_TOUCH=yes\n',
      'symlink target must remain untouched'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(path.join(tmpdir(), 'zbrowse-env-integrity-directory-'));
  const envPath = path.join(root, '.env');
  const templatePath = path.join(root, '.env.example');
  try {
    writeFileSync(templatePath, 'PORT=8090\n', 'utf8');
    mkdirSync(envPath);

    const result = run([envPath, templatePath]);
    assert.notEqual(result.status, 0, 'non-file .env path must be rejected');
    assert.match(result.stderr, /Environment path must be a regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('zBrowse environment file integrity contract passed');
