// Deterministic real-CLI and assessor tests. Synthetic Docker inspect inputs only;
// the actual VPS/browser effective posture is NOT established by this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED, assessDockerInspect } from '../tools/zbrowse-selkies-effective-posture.mjs';

const entry = fileURLToPath(new URL('../tools/zbrowse-selkies-effective-posture.mjs', import.meta.url));
const secret = 'synthetic-password-NEVER-PRINT-9x7';
const bearer = 'synthetic-bearer-NEVER-PRINT-4y2';
function fixture(overrides = {}) {
  return [{
    Id: 'a'.repeat(64),
    Name: '/zbrowse-abc123def456',
    State: { Running: true, Status: 'running' },
    HostConfig: {
      Privileged: false, NetworkMode: 'zbrowse_net', AutoRemove: true,
      Memory: 2147483648, NanoCpus: 1000000000, PidsLimit: 350,
      SecurityOpt: ['no-new-privileges:true'], CapAdd: [],
      Binds: null, Mounts: null, Devices: [], DeviceRequests: [],
      PortBindings: {}, Tmpfs: {
        '/config': 'rw,noexec,nosuid,size=768m',
        '/tmp': 'rw,noexec,nosuid,size=256m'
      }
    },
    NetworkSettings: { Ports: {} },
    Mounts: [],
    Config: {
      Labels: { 'zbrowse.managed': 'true' },
      Env: [
        ...REQUIRED.map(([key, value]) => key + '=' + value),
        'PASSWORD=' + secret,
        'SUBFOLDER=/s/' + bearer + '/',
        'TITLE=zBrowse',
        ...(overrides.entries ?? [])
      ]
    }
  }];
}
function run(document, args = ['--require-selkies-effective']) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    input: typeof document === 'string' ? document : JSON.stringify(document)
  });
}
function privateOutput(child) {
  assert.doesNotMatch(child.stdout + child.stderr, new RegExp(secret + '|' + bearer),
    'acceptance diagnostics must never print Docker credentials or session identifiers');
}

const good = fixture();
assert.deepEqual(assessDockerInspect(good), { acceptable: true, gaps: [] });
const accepted = run(good);
assert.equal(accepted.status, 0, 'strict CLI must accept one fully hardened managed container');
assert.match(accepted.stdout, /effective Selkies environment PASS/);
privateOutput(accepted);

for (const [key] of REQUIRED) {
  const omitted = fixture();
  omitted[0].Config.Env = omitted[0].Config.Env.filter(value => !value.startsWith(key + '='));
  assert.deepEqual(assessDockerInspect(omitted).gaps, [key],
    key + ': missing required effective variable must fail');
  const absent = run(omitted);
  assert.equal(absent.status, 1, key + ': missing setting must fail strict CLI');
  assert.match(absent.stderr, new RegExp(key),
    key + ': diagnostic should name the reviewed missing setting');
  privateOutput(absent);

  const relaxed = fixture();
  relaxed[0].Config.Env = relaxed[0].Config.Env.map(entry =>
    entry.startsWith(key + '=') ? key + '=unsafe' : entry);
  assert.deepEqual(assessDockerInspect(relaxed).gaps, [key],
    key + ': unsafe effective value must fail');
  const weak = run(relaxed);
  assert.equal(weak.status, 1, key + ': weakened setting must fail strict CLI');
  privateOutput(weak);
}

// An apparently hardened Selkies env may still sit inside an effectively
// privileged, host-attached or unlimited container. Reject those false green
// states on the actual CLI and never disclose inspect values in diagnostics.
const containmentCases = [
  ['privileged', { Privileged: true }, 'DOCKER_PRIVILEGED'],
  ['host network', { NetworkMode: 'host' }, 'DOCKER_NETWORK'],
  ['default bridge', { NetworkMode: 'bridge' }, 'DOCKER_NETWORK'],
  ['container network reuse', { NetworkMode: 'container:another' }, 'DOCKER_NETWORK'],
  ['persistent browser', { AutoRemove: false }, 'DOCKER_AUTO_REMOVE'],
  ['unlimited memory', { Memory: 0 }, 'DOCKER_MEMORY_LIMIT'],
  ['unlimited cpu', { NanoCpus: 0 }, 'DOCKER_CPU_LIMIT'],
  ['unlimited pids', { PidsLimit: 0 }, 'DOCKER_PID_LIMIT'],
  ['no privilege control', { SecurityOpt: [] }, 'DOCKER_SECURITY_OPT'],
  ['unconfined seccomp', { SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] },
    'DOCKER_SECURITY_OPT'],
  ['added sysadmin', { CapAdd: ['SYS_ADMIN'] }, 'DOCKER_CAPABILITIES'],
  ['host PID namespace', { PidMode: 'host' }, 'DOCKER_CAPABILITIES'],
  ['host user namespace', { UsernsMode: 'host' }, 'DOCKER_CAPABILITIES'],
  ['docker socket bind', { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] },
    'DOCKER_HOST_MOUNTS'],
  ['host home mount', { Mounts: [{ Type: 'bind', Source: '/home', Target: '/home' }] },
    'DOCKER_HOST_MOUNTS'],
  ['device passthrough', { Devices: [{ PathOnHost: '/dev/kvm' }] }, 'DOCKER_DEVICES'],
  ['device request', { DeviceRequests: [{ Driver: 'nvidia' }] }, 'DOCKER_DEVICES'],
  ['published port', { PortBindings: { '3001/tcp': [{ HostPort: '3001' }] } },
    'DOCKER_PUBLISHED_PORTS'],
  ['writable executable config', { Tmpfs: {
    '/config': 'rw,suid,exec,size=768m', '/tmp': 'rw,noexec,nosuid,size=256m'
  } }, 'DOCKER_CONFIG_TMPFS'],
  ['oversized config tmpfs', { Tmpfs: {
    '/config': 'rw,noexec,nosuid,size=100g', '/tmp': 'rw,noexec,nosuid,size=256m'
  } }, 'DOCKER_CONFIG_TMPFS'],
  ['unrestricted temp filesystem', { Tmpfs: {
    '/config': 'rw,noexec,nosuid,size=768m', '/tmp': 'rw,size=256m'
  } }, 'DOCKER_TMP_TMPFS']
];
for (const [label, mutation, expected] of containmentCases) {
  const changed = fixture();
  Object.assign(changed[0].HostConfig, mutation);
  const result = assessDockerInspect(changed);
  assert.ok(result.gaps.includes(expected), label + ': source assessor must catch containment');
  assert.equal(result.acceptable, false, label + ': unsafe container cannot pass');
  const child = run(changed);
  assert.equal(child.status, 1, label + ': real verifier CLI must fail closed');
  assert.match(child.stderr, new RegExp(expected), label + ': report only reviewed gap name');
  privateOutput(child);
}
for (const [label, mutated, expected] of [
  ['host bind at effective level', { Mounts: [{ Type: 'bind',
    Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }] },
  'DOCKER_EFFECTIVE_MOUNTS'],
  ['published network setting', { NetworkSettings: {
    Ports: { '3001/tcp': [{ HostIp: '0.0.0.0', HostPort: '3001' }] }
  } }, 'DOCKER_PUBLISHED_PORTS']
]) {
  const changed = fixture();
  Object.assign(changed[0], mutated);
  assert.ok(assessDockerInspect(changed).gaps.includes(expected), label + ': reject bypass');
  const child = run(changed);
  assert.equal(child.status, 1, label + ': real CLI must reject bypass');
  privateOutput(child);
}

const deprecated = fixture({ entries: ['SELKIES_ENABLE_FILE_TRANSFER=false'] });
assert.deepEqual(assessDockerInspect(deprecated).gaps, ['SELKIES_ENABLE_FILE_TRANSFER'],
  'unsupported legacy file-transfer key must fail');
const obsolete = run(deprecated);
assert.equal(obsolete.status, 1);
privateOutput(obsolete);

const invalidInputs = [
  ['stopped browser', [{ ...good[0], State: { Running: false, Status: 'exited' } }]],
  ['missing container identity', [{ ...good[0], Id: '' }]],
  ['foreign container name', [{ ...good[0], Name: '/untrusted-app' }]],
  ['name without managed prefix', [{ ...good[0], Name: '/zbrowse-abc' }]],
  ['unmanaged browser', [{ Config: {
    Labels: { 'zbrowse.managed': 'false' }, Env: good[0].Config.Env
  } }]],
  ['multiple inspect objects', [good[0], good[0]]],
  ['empty inspect array', []],
  ['duplicate env key', fixture({ entries: ['HARDEN_DESKTOP=false'] })],
  ['malformed env entry', fixture({ entries: ['BROKEN_ENV'] })],
  ['lowercase unexpected env key', fixture({ entries: ['test_value=bad'] })],
  ['nonstring env entry', fixture({ entries: [123] })],
  ['oversized env list', [{ Config: { Labels: { 'zbrowse.managed': 'true' },
    Env: Array.from({ length: 257 }, (_, i) => 'KEY_' + i + '=ok')
  } }]]
];
for (const [label, input] of invalidInputs) {
  assert.throws(() => assessDockerInspect(input), { code: 'ERR_ASSERTION' },
    label + ': invalid Docker inspect must be rejected');
  const child = run(input);
  assert.equal(child.status, 1, label + ': strict CLI must reject bad inspect');
  assert.match(child.stderr, /invalid inspect input or invocation/,
    label + ': malformed data must have generic sanitized diagnostic');
  privateOutput(child);
}
for (const args of [
  [], ['--unknown'], ['--require-selkies-effective', '--require-selkies-effective'],
  ['--require-selkies-effective=true']
]) {
  const child = run(good, args);
  assert.equal(child.status, 1, 'invalid invocation must fail closed before judging effective posture');
  privateOutput(child);
}
for (const text of [
  '{"Config":{"PASSWORD":"' + secret + '"}}',
  'not-json ' + secret,
  JSON.stringify(good) + '\n' + secret,
  ' '.repeat(1024 * 1024 + 1)
]) {
  const child = run(text);
  assert.equal(child.status, 1, 'invalid/oversize Docker JSON must fail closed');
  privateOutput(child);
}
console.log('Synthetic effective Selkies Docker inspect: 8 required settings × 2 negatives, ' +
  'legacy/invalid/CLI/privacy guards PASS (not a VPS acceptance)');
