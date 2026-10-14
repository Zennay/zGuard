// Read-only Docker-inspect verifier for a single *actual* managed zBrowse
// browser container. Never print the inspect document: it carries PASSWORD,
// bearer-derived paths and other sensitive session material.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const REQUIRED = Object.freeze([
  ['HARDEN_DESKTOP', 'true'],
  ['HARDEN_OPENBOX', 'true'],
  ['SELKIES_FILE_TRANSFERS', 'none'],
  ['SELKIES_ENABLE_CLIPBOARD', 'false|locked'],
  ['SELKIES_COMMAND_ENABLED', 'false|locked'],
  ['NO_WEBCAM', 'true'],
  ['NO_GAMEPAD', 'true'],
  ['START_DOCKER', 'false']
]);

export function assessDockerInspect(document) {
  assert.ok(Array.isArray(document) && document.length === 1,
    'inspect must contain exactly one browser container');
  const container = document[0];
  assert.ok(container && typeof container === 'object' && !Array.isArray(container),
    'inspect container must be an object');
  assert.equal(container.Config?.Labels?.['zbrowse.managed'], 'true',
    'inspect must identify a managed zBrowse browser');
  // An offline record or a fabricated non-container object is not runtime
  // inspection evidence. Docker inspect provides these stable identity/state
  // fields; they must identify one actively running managed browser.
  assert.match(container.Id ?? '', /^[a-f0-9]{64}$/,
    'inspect must identify a real-format Docker container ID');
  assert.match(container.Name ?? '', /^\\/zbrowse-[a-z0-9_-]{12}$/,
    'inspect must target a named zBrowse session container');
  assert.equal(container.State?.Running, true,
    'inspect cannot certify a stopped browser container');
  assert.equal(container.State?.Status, 'running',
    'inspect must describe the running Docker lifecycle state');
  const entries = container.Config?.Env;
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 256,
    'inspect must contain a bounded effective Docker environment');

  const env = new Map();
  for (const entry of entries) {
    assert.equal(typeof entry, 'string', 'Docker env values must be strings');
    const index = entry.indexOf('=');
    assert.ok(index > 0, 'Docker Env requires NAME=value');
    const key = entry.slice(0, index);
    assert.match(key, /^[A-Z][A-Z0-9_]*$/,
      'Docker env key must be a reviewable uppercase identifier');
    assert.ok(!env.has(key), 'duplicate effective Docker environment name');
    env.set(key, entry.slice(index + 1));
  }
  const gaps = REQUIRED.filter(([key, value]) => env.get(key) !== value)
    .map(([key]) => key);
  if (env.has('SELKIES_ENABLE_FILE_TRANSFER')) {
    gaps.push('SELKIES_ENABLE_FILE_TRANSFER');
  }
  return { acceptable: gaps.length === 0, gaps };
}

async function main() {
  // The CLI never provides an advisory success exit code: an operator must
  // explicitly request strict verification of an actual docker inspect JSON.
  assert.deepEqual(process.argv.slice(2), ['--require-selkies-effective'],
    'use --require-selkies-effective with one docker inspect JSON document on stdin');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    assert.ok(bytes <= 1024 * 1024, 'Docker inspect input exceeds 1 MiB');
    chunks.push(chunk);
  }
  assert.ok(bytes > 0, 'Docker inspect input must not be empty');
  const inspected = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = assessDockerInspect(inspected);
  assert.deepEqual(result.gaps, [],
    'effective managed browser is missing required kiosk configuration: ' +
    result.gaps.join(', '));
  console.log('zBrowse effective Selkies environment PASS (one managed Docker container)');
}

if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Only emit fixed code/category and the names of reviewed configuration
    // keys; never error.message or the raw Docker inspect input.
    if (error.code === 'ERR_ASSERTION' &&
        /^effective managed browser is missing required kiosk configuration: /.test(error.message)) {
      const names = error.message.split(': ').at(-1);
      console.error('Selkies effective-env gate FAIL: ' + names);
    } else {
      console.error('Selkies effective-env gate FAIL: invalid inspect input or invocation');
    }
    process.exitCode = 1;
  });
}
