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
  assert.match(container.Name ?? '', /^\/zbrowse-[a-z0-9_-]{12}$/,
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
  // Effective Docker isolation must not become an implicit PASS merely
  // because the Selkies variables were set. No Docker mutation is done here.
  // All emitted gap identifiers are fixed constants, never inspect values.
  const host = container.HostConfig ?? {};
  if (host.Privileged !== false) gaps.push('DOCKER_PRIVILEGED');
  const network = host.NetworkMode;
  if (typeof network !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{1,62}$/.test(network) ||
      ['host', 'bridge', 'none', 'default'].includes(network.toLowerCase())) {
    gaps.push('DOCKER_NETWORK');
  }
  if (host.AutoRemove !== true) gaps.push('DOCKER_AUTO_REMOVE');
  // Positive values alone do not bound a session. Excessively large limits
  // make the browser effectively unrestricted on the shared VPS. These are
  // explicit release-QA ceilings, not automatic production configuration.
  if (!Number.isSafeInteger(host.Memory) || host.Memory <= 0 ||
      host.Memory > 4 * 1024 ** 3) gaps.push('DOCKER_MEMORY_LIMIT');
  if (!Number.isSafeInteger(host.NanoCpus) || host.NanoCpus <= 0 ||
      host.NanoCpus > 2 * 1e9) gaps.push('DOCKER_CPU_LIMIT');
  if (!Number.isSafeInteger(host.PidsLimit) || host.PidsLimit <= 0 ||
      host.PidsLimit > 350) gaps.push('DOCKER_PID_LIMIT');

  const options = host.SecurityOpt;
  // The gateway launches with exactly one reviewed option. Merely including
  // no-new-privileges is insufficient if an additional option weakens
  // seccomp/AppArmor/labels or silently changes future Docker behavior.
  if (!Array.isArray(options) || options.length !== 1 ||
      options[0] !== 'no-new-privileges:true') {
    gaps.push('DOCKER_SECURITY_OPT');
  }
  if (!Array.isArray(host.CapAdd ?? []) || (host.CapAdd ?? []).length > 0 ||
      host.UsernsMode === 'host' || host.PidMode === 'host' ||
      host.IpcMode === 'host' || host.UTSMode === 'host') {
    gaps.push('DOCKER_CAPABILITIES');
  }
  // A host cgroup namespace exposes the host's cgroup hierarchy to the
  // browser, and disabling the OOM killer undermines bounded shared-VPS
  // resource containment even if the configured memory cap is positive.
  if (host.CgroupnsMode === 'host') gaps.push('DOCKER_CGROUP_NAMESPACE');
  if (host.OomKillDisable === true) gaps.push('DOCKER_OOM_KILLER');
  if (!Array.isArray(host.Binds ?? []) || (host.Binds ?? []).length > 0 ||
      !Array.isArray(host.Mounts ?? []) || (host.Mounts ?? []).length > 0) {
    gaps.push('DOCKER_HOST_MOUNTS');
  }
  if (!Array.isArray(host.Devices ?? []) || (host.Devices ?? []).length > 0 ||
      !Array.isArray(host.DeviceRequests ?? []) || (host.DeviceRequests ?? []).length > 0) {
    gaps.push('DOCKER_DEVICES');
  }
  if (!host.PortBindings || typeof host.PortBindings !== 'object' ||
      Array.isArray(host.PortBindings) || Object.keys(host.PortBindings).length > 0 ||
      (container.NetworkSettings?.Ports &&
       Object.values(container.NetworkSettings.Ports).some(binding =>
         Array.isArray(binding) && binding.length > 0))) {
    gaps.push('DOCKER_PUBLISHED_PORTS');
  }
  // Docker inspect may list its own tmpfs mounts separately. Any mounted
  // host file, Docker socket or persistent volume is forbidden for a kiosk.
  if (!Array.isArray(container.Mounts ?? []) ||
      (container.Mounts ?? []).some(mount =>
        !mount || mount.Type !== 'tmpfs' ||
        !['/config', '/tmp'].includes(mount.Destination))) {
    gaps.push('DOCKER_EFFECTIVE_MOUNTS');
  }
  for (const [directory, maxBytes, label] of [
    ['/config', 2 * 1024 ** 3, 'DOCKER_CONFIG_TMPFS'],
    ['/tmp', 1024 ** 3, 'DOCKER_TMP_TMPFS']
  ]) {
    const raw = host.Tmpfs?.[directory];
    const parts = typeof raw === 'string' ? raw.split(',') : [];
    const size = parts.find(part => /^size=/.test(part));
    const match = size?.match(/^size=(\d+)([kmg])$/i);
    const units = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
    const byteSize = match ? Number(match[1]) * units[match[2].toLowerCase()] : 0;
    if (!parts.includes('noexec') || !parts.includes('nosuid') ||
        !Number.isSafeInteger(byteSize) || byteSize <= 0 ||
        byteSize > maxBytes || parts.includes('exec') || parts.includes('suid')) {
      gaps.push(label);
    }
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
