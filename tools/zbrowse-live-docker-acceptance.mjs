// Operator-only, read-only *live* Docker acceptance for an existing zBrowse
// session. Never print docker inspect JSON, Docker stderr, token or password.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assessDockerInspect } from './zbrowse-selkies-effective-posture.mjs';

function docker(args, maxBuffer = 1024 * 1024) {
  return execFileSync('docker', args, {
    encoding: 'utf8', timeout: 8000, maxBuffer,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

function main() {
  assert.deepEqual(process.argv.slice(2), ['--require-live-docker'],
    'explicit live Docker acceptance flag required');
  const listing = docker([
    'ps', '--quiet', '--no-trunc',
    '--filter', 'label=zbrowse.managed=true',
    '--filter', 'status=running'
  ], 4096);
  const ids = listing.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(ids.length, 1, 'exactly one running managed browser is required');
  assert.match(ids[0], /^[a-f0-9]{64}$/,
    'Docker must return a complete validated container ID');
  const inspected = JSON.parse(docker(['inspect', ids[0]]));
  assert.equal(inspected?.[0]?.Id, ids[0],
    'inspection must be bound to the discovered running container ID');
  const { gaps } = assessDockerInspect(inspected);
  if (gaps.length) {
    // Gaps are a closed list of reviewed configuration key names and fixed
    // DOCKER_* constants; never include inspect properties or their values.
    console.error('Live zBrowse Docker acceptance FAIL: ' + gaps.join(', '));
    process.exitCode = 1;
    return;
  }
  console.log('Live zBrowse Docker acceptance PASS (one running managed browser)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (_) {
    // Error objects from child_process can contain command/args/stderr.
    // Suppress them unconditionally to prevent secret-bearing diagnostics.
    console.error('Live zBrowse Docker acceptance FAIL: invalid runtime state or invocation');
    process.exitCode = 1;
  }
}
