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

const effectivePorts = container.NetworkSettings?.Ports || {};
const published = Object.values(effectivePorts).flat().filter(Boolean);
assert.equal(published.length, 1, 'running gateway must expose exactly one effective host binding');
assert.equal(published[0].HostIp, '127.0.0.1', 'effective gateway binding must stay on IPv4 loopback');
assert.match(published[0].HostPort, /^\d+$/, 'effective gateway host port must be numeric');

const baseUrl = `http://127.0.0.1:${published[0].HostPort}`;

function assertSecurityHeaders(response, label) {
  assert.equal(
    response.headers.get('x-content-type-options'),
    'nosniff',
    `${label} must prevent MIME sniffing`
  );
  assert.equal(
    response.headers.get('x-frame-options'),
    'SAMEORIGIN',
    `${label} must keep clickjacking protection enabled`
  );
  assert.equal(
    response.headers.get('referrer-policy'),
    'no-referrer',
    `${label} must not leak referrer data`
  );
  assert.equal(response.headers.get('x-powered-by'), null, `${label} must not expose Express`);

  const csp = response.headers.get('content-security-policy') || '';
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "frame-src 'self'",
    "connect-src 'self' wss: ws:",
  ]) {
    assert.ok(csp.includes(directive), `${label} CSP must include ${directive}`);
  }
}

const healthResponse = await fetch(
  `${baseUrl}/api/health`,
  { signal: AbortSignal.timeout(5_000) }
);
assert.equal(healthResponse.status, 200, 'live /api/health must return HTTP 200');
assert.match(
  healthResponse.headers.get('content-type') || '',
  /^application\/json\b/i,
  'live /api/health must return JSON'
);
const health = await healthResponse.json();
assert.equal(health.status, 'ok', 'live /api/health status must be ok');
for (const key of ['activeSessions', 'startingSessions', 'capacity']) {
  assert.ok(Number.isInteger(health[key]), `live /api/health ${key} must be an integer`);
  assert.ok(health[key] >= 0, `live /api/health ${key} must not be negative`);
}
assert.ok(health.capacity >= 1, 'live /api/health capacity must be at least one');
assert.ok(
  health.activeSessions + health.startingSessions <= health.capacity,
  'live /api/health usage must not exceed reported capacity'
);
assert.equal(health.activeSessions, 0, 'fresh gateway boot must not report active sessions');
assert.equal(health.startingSessions, 0, 'fresh gateway boot must not report pending sessions');
assertSecurityHeaders(healthResponse, 'live /api/health');

const portalResponse = await fetch(baseUrl + '/', { signal: AbortSignal.timeout(5_000) });
assert.equal(portalResponse.status, 200, 'live portal root must return HTTP 200');
assert.match(
  portalResponse.headers.get('content-type') || '',
  /^text\/html\b/i,
  'live portal root must return HTML'
);
assertSecurityHeaders(portalResponse, 'live portal root');
const portalHtml = await portalResponse.text();
assert.match(portalHtml, /<title>zBrowse<\/title>/, 'live portal root must serve the zBrowse shell');
assert.match(
  portalHtml,
  /id="browserForm"/,
  'live portal root must include the browser launch form'
);

const missingApiResponse = await fetch(baseUrl + '/api/definitely-missing', {
  signal: AbortSignal.timeout(5_000),
});
assert.equal(missingApiResponse.status, 404, 'unknown API route must remain a JSON 404');
assert.match(
  missingApiResponse.headers.get('content-type') || '',
  /^application\/json\b/i,
  'unknown API route must not fall through to SPA HTML'
);
assertSecurityHeaders(missingApiResponse, 'unknown API route');
assert.deepEqual(
  await missingApiResponse.json(),
  { error: 'API route not found.' },
  'unknown API route must return only the generic API error'
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
