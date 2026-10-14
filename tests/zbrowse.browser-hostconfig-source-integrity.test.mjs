import assert from 'node:assert/strict';
import fs from 'node:fs';

// Browser session runtime fields are owned by the gateway worker. This test
// locks the reviewed source without changing those fields or using Docker.
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const canonical = [
  'HostConfig: {',
  'AutoRemove: true,',
  'NetworkMode: config.network,',
  'Memory: config.memoryBytes,',
  'NanoCpus: config.nanoCpus,',
  'PidsLimit: 350,',
  'ShmSize: 1024 * 1024 * 1024,',
  'SecurityOpt: ["no-new-privileges:true"],',
  'Tmpfs: {',
  '"/config": "rw,noexec,nosuid,size=768m",',
  '"/tmp": "rw,noexec,nosuid,size=256m"',
  '}',
  '}'
].join('\n');

function validate(input) {
  const starts = [...input.matchAll(/docker\.createContainer\s*\(/g)];
  assert.equal(starts.length, 1, 'exactly one browser container launch must exist');
  const start = input.indexOf('    HostConfig: {', starts[0].index);
  assert.ok(start > starts[0].index, 'HostConfig must be inline and reviewable');
  const stop = input.indexOf('\n    }\n  });', start);
  assert.ok(stop > start, 'HostConfig must close the actual Docker creation');
  const actual = input.slice(start, stop + '\n    }'.length)
    .split(/\r?\n/).map(line => line.trim()).join('\n');
  assert.equal(actual, canonical, 'browser HostConfig drift must receive security review');
  assert.match(input.slice(starts[0].index, start),
    /"zbrowse\.managed":\s*"true"/,
    'Docker browser must retain its managed identity label');
}
validate(source);

const changes = [
  ['privileged', 'AutoRemove: true,', 'AutoRemove: true,\n      Privileged: true,'],
  ['Docker socket', 'AutoRemove: true,',
    'AutoRemove: true,\n      Binds: ["/var/run/docker.sock:/var/run/docker.sock"],'],
  ['host network', 'NetworkMode: config.network,', 'NetworkMode: "host",'],
  ['default bridge', 'NetworkMode: config.network,', 'NetworkMode: "bridge",'],
  ['persistent', 'AutoRemove: true,', 'AutoRemove: false,'],
  ['unlimited memory', 'Memory: config.memoryBytes,', 'Memory: 0,'],
  ['unlimited CPU', 'NanoCpus: config.nanoCpus,', 'NanoCpus: 0,'],
  ['unlimited processes', 'PidsLimit: 350,', 'PidsLimit: 0,'],
  ['no-new-privileges removed', 'SecurityOpt: ["no-new-privileges:true"],',
    'SecurityOpt: ["no-new-privileges:false"],'],
  ['extra Linux privileges', 'PidsLimit: 350,',
    'PidsLimit: 350,\n      CapAdd: ["SYS_ADMIN"],'],
  ['host PID namespace', 'PidsLimit: 350,',
    'PidsLimit: 350,\n      PidMode: "host",'],
  ['host IPC namespace', 'PidsLimit: 350,',
    'PidsLimit: 350,\n      IpcMode: "host",'],
  ['host devices', 'PidsLimit: 350,',
    'PidsLimit: 350,\n      Devices: [{ PathOnHost: "/dev/kvm" }],'],
  ['published port', 'PidsLimit: 350,',
    'PidsLimit: 350,\n      PortBindings: {"3001/tcp": [{HostPort:"3001"}]},'],
  ['executable config tmpfs', 'rw,noexec,nosuid,size=768m', 'rw,exec,suid,size=768m'],
  ['unbounded tmpfs', 'rw,noexec,nosuid,size=256m', 'rw'],
  ['removed tmpfs', '      Tmpfs: {', '      OldTmpfs: {'],
  ['excessive shared memory', 'ShmSize: 1024 * 1024 * 1024,',
    'ShmSize: 16 * 1024 * 1024 * 1024,'],
  ['unmanaged identity', '"zbrowse.managed": "true"', '"zbrowse.managed": "false"'],
  ['extra container creation', 'const container = await docker.createContainer({',
    'await docker.createContainer({});\n  const container = await docker.createContainer({']
];
for (const [label, oldText, replacement] of changes) {
  assert.ok(source.includes(oldText), label + ': mutation anchor must exist');
  assert.throws(() => validate(source.replace(oldText, replacement)),
    { code: 'ERR_ASSERTION' }, label + ': unreviewed browser container must fail');
}
console.log('Browser HostConfig source boundary: 20 dangerous mutations rejected');
