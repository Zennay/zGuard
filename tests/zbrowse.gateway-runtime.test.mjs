import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

const containerName = process.argv[2] || 'zbrowse-gateway';

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

const inspected = JSON.parse(docker(['inspect', containerName]));
assert.equal(inspected.length, 1, 'expected exactly one gateway container');

const container = inspected[0];
const host = container.HostConfig || {};
const config = container.Config || {};
const state = container.State || {};

assert.equal(config.User, 'node', 'gateway image must run as the non-root node user');
assert.equal(host.ReadonlyRootfs, true, 'effective gateway root filesystem must be read-only');
assert.equal(host.Privileged, false, 'gateway must not run privileged');
assert.notEqual(host.NetworkMode, 'host', 'gateway must not use host networking');

const droppedCaps = new Set(host.CapDrop || []);
assert.ok(droppedCaps.has('ALL'), 'effective gateway container must drop all Linux capabilities');
assert.equal((host.CapAdd || []).length, 0, 'gateway must not add Linux capabilities');

const securityOptions = host.SecurityOpt || [];
assert.ok(
  securityOptions.some((value) => value === 'no-new-privileges:true'),
  'effective gateway container must enable no-new-privileges'
);

const tmpfs = host.Tmpfs?.['/tmp'];
assert.ok(tmpfs, 'effective gateway container must mount /tmp as tmpfs');
for (const option of ['noexec', 'nosuid', 'nodev']) {
  assert.ok(
    tmpfs.split(',').some((entry) => entry === option),
    `effective /tmp tmpfs must include ${option}`
  );
}

assert.equal(
  host.RestartPolicy?.Name,
  'unless-stopped',
  'effective gateway restart policy must remain unless-stopped'
);

const portBindings = host.PortBindings || {};
const boundPorts = Object.entries(portBindings);
assert.equal(boundPorts.length, 1, 'gateway must publish exactly one container port');
for (const [, bindings] of boundPorts) {
  assert.ok(Array.isArray(bindings) && bindings.length > 0, 'gateway port must have a host binding');
  for (const binding of bindings) {
    assert.equal(binding.HostIp, '127.0.0.1', 'gateway port must bind only to IPv4 loopback');
  }
}

assert.equal(state.Health?.Status, 'healthy', 'gateway must be healthy before runtime assertions');
assert.ok(
  (config.Healthcheck?.Test || []).join(' ').includes('/api/health'),
  'effective image healthcheck must probe /api/health'
);

const mounts = container.Mounts || [];
const configMount = mounts.find((mount) => mount.Destination === '/app/config');
assert.ok(configMount, 'gateway must mount its config directory');
assert.equal(configMount.RW, false, 'gateway config mount must be read-only');

const socketMount = mounts.find((mount) => mount.Destination === '/var/run/docker.sock');
assert.ok(socketMount, 'gateway must mount the Docker socket');
assert.equal(socketMount.Type, 'bind', 'Docker socket must be an explicit bind mount');

const unexpectedBind = mounts.find(
  (mount) =>
    mount.Type === 'bind' &&
    !['/app/config', '/var/run/docker.sock'].includes(mount.Destination)
);
assert.equal(unexpectedBind, undefined, 'gateway must not gain unexpected host bind mounts');

const effectiveUid = docker(['exec', containerName, 'sh', '-lc', 'id -u']);
assert.notEqual(effectiveUid, '0', 'effective gateway process user must not be root');

const socketGid = docker(['exec', containerName, 'sh', '-lc', "stat -c '%g' /var/run/docker.sock"]);
const effectiveGroups = new Set(
  docker(['exec', containerName, 'sh', '-lc', 'id -G'])
    .split(/\s+/)
    .filter(Boolean)
);
assert.ok(
  effectiveGroups.has(socketGid),
  `gateway user must inherit the Docker socket group ${socketGid}`
);
assert.ok(
  new Set(host.GroupAdd || []).has(socketGid),
  `Compose must add the effective Docker socket group ${socketGid}`
);

const dockerPing = spawnSync(
  'docker',
  [
    'exec',
    containerName,
    'node',
    '--input-type=module',
    '-e',
    "import Docker from 'dockerode'; const docker = new Docker({socketPath:'/var/run/docker.sock'}); await docker.ping();",
  ],
  { encoding: 'utf8' }
);
assert.equal(
  dockerPing.status,
  0,
  `non-root gateway must be able to reach the Docker API: ${dockerPing.stderr || dockerPing.stdout}`
);

const rootWrite = spawnSync(
  'docker',
  ['exec', containerName, 'sh', '-lc', 'touch /runtime-rootfs-write-probe'],
  { encoding: 'utf8' }
);
assert.notEqual(rootWrite.status, 0, 'read-only root filesystem must reject a real write probe');

const tmpWrite = spawnSync(
  'docker',
  [
    'exec',
    containerName,
    'sh',
    '-lc',
    'probe=/tmp/zbrowse-runtime-write-probe; touch "$probe" && rm "$probe"',
  ],
  { encoding: 'utf8' }
);
assert.equal(
  tmpWrite.status,
  0,
  `bounded /tmp must remain writable for runtime needs: ${tmpWrite.stderr || tmpWrite.stdout}`
);

console.log('zBrowse live gateway runtime containment passed');
