// Source-executing CLI acceptance with a synthetic Docker executable.
// CI never contacts a Docker daemon and never inspects production sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED } from '../tools/zbrowse-selkies-effective-posture.mjs';

const entry = fileURLToPath(new URL('../tools/zbrowse-live-docker-acceptance.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbrowse-live-inspect-'));
const token = 'FORBIDDEN_SYNTHETIC_BEARER_987654';
const password = 'FORBIDDEN_SYNTHETIC_PASSWORD_123456';
const id = 'a'.repeat(64);
const calls = path.join(dir, 'calls.txt');
const shim = path.join(dir, 'docker');

function fixture() {
  return [{
    Id: id, Name: '/zbrowse-abc123def456',
    State: { Running: true, Status: 'running' },
    Config: { Labels: { 'zbrowse.managed': 'true' },
      Env: [
        ...REQUIRED.map(([key, value]) => key + '=' + value),
        'PASSWORD=' + password, 'SUBFOLDER=/s/' + token + '/'
      ]
    },
    HostConfig: {
      Privileged: false, NetworkMode: 'zbrowse_net',
      AutoRemove: true, Memory: 2147483648, NanoCpus: 1000000000,
      PidsLimit: 350, SecurityOpt: ['no-new-privileges:true'],
      CapAdd: [], Binds: null, Mounts: null, Devices: [], DeviceRequests: [],
      PortBindings: {},
      Tmpfs: {
        '/config': 'rw,noexec,nosuid,size=768m',
        '/tmp': 'rw,noexec,nosuid,size=256m'
      }
    },
    NetworkSettings: { Ports: {} }, Mounts: []
  }];
}

const fakeDocker = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "const args = process.argv.slice(2);",
  "fs.appendFileSync(process.env.QA_DOCKER_CALLS, JSON.stringify(args) + '\\n');",
  "if (process.env.QA_DOCKER_THROW === args[0]) {",
  "  console.error(process.env.QA_DOCKER_LEAK); process.exit(34);",
  "}",
  "if (args[0] === 'ps') process.stdout.write(process.env.QA_DOCKER_IDS ?? '');",
  "else if (args[0] === 'inspect') process.stdout.write(process.env.QA_DOCKER_JSON ?? '');",
  "else process.exit(35);"
].join('\n');
fs.writeFileSync(shim, fakeDocker, { mode: 0o755 });

function run({ ids = id, inspect = fixture(), fail = '', args = ['--require-live-docker'] } = {}) {
  fs.writeFileSync(calls, '');
  const child = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    env: {
      ...process.env, PATH: dir + path.delimiter + process.env.PATH,
      QA_DOCKER_CALLS: calls, QA_DOCKER_IDS: ids,
      QA_DOCKER_JSON: typeof inspect === 'string' ? inspect : JSON.stringify(inspect),
      QA_DOCKER_THROW: fail, QA_DOCKER_LEAK: password + token
    }
  });
  assert.doesNotMatch((child.stdout ?? '') + (child.stderr ?? ''),
    new RegExp(password + '|' + token),
    'credentials, Docker stderr and session bearer must never leak');
  return {
    child,
    commands: fs.readFileSync(calls, 'utf8').trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line))
  };
}

try {
  const good = run();
  assert.equal(good.child.status, 0, 'hardened running container must pass');
  assert.match(good.child.stdout, /Docker acceptance PASS/);
  assert.deepEqual(good.commands, [
    ['ps', '--quiet', '--no-trunc',
      '--filter', 'label=zbrowse.managed=true',
      '--filter', 'status=running'],
    ['inspect', id]
  ], 'CLI must execute only read-only Docker discovery and exact-ID inspection');

  const dangerous = [
    ['privileged', document => { document[0].HostConfig.Privileged = true; }, 'DOCKER_PRIVILEGED'],
    ['host network', document => { document[0].HostConfig.NetworkMode = 'host'; }, 'DOCKER_NETWORK'],
    ['host mount', document => {
      document[0].HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'];
    }, 'DOCKER_HOST_MOUNTS'],
    ['weakened kiosk', document => {
      document[0].Config.Env = document[0].Config.Env.filter(x => !x.startsWith('HARDEN_DESKTOP='));
    }, 'HARDEN_DESKTOP']
  ];
  for (const [name, mutate, marker] of dangerous) {
    const document = fixture(); mutate(document);
    const result = run({ inspect: document });
    assert.equal(result.child.status, 1, name + ': unsafe live inspect must fail');
    assert.match(result.child.stderr, new RegExp(marker),
      name + ': only reviewed safe gap identifier may be shown');
  }
  for (const [name, input] of [
    ['zero sessions', { ids: '' }],
    ['two sessions', { ids: id + '\n' + 'b'.repeat(64) }],
    ['invalid ID', { ids: 'not-a-real-id' }],
    ['inspect wrong ID', { inspect: [{ ...fixture()[0], Id: 'b'.repeat(64) }] }],
    ['invalid Docker JSON', { inspect: '{invalid\n' + password }],
    ['Docker list failure', { fail: 'ps' }],
    ['Docker inspect failure', { fail: 'inspect' }],
    ['wrong CLI option', { args: ['--wrong'] }],
    ['missing CLI option', { args: [] }],
    ['duplicated CLI option', { args: ['--require-live-docker', '--require-live-docker'] }]
  ]) {
    const result = run(input);
    assert.equal(result.child.status, 1, name + ': fail closed');
    assert.match(result.child.stderr, /invalid runtime state or invocation/,
      name + ': generic error may not disclose child process diagnostics');
    if (['zero sessions', 'two sessions', 'invalid ID', 'wrong CLI option',
      'missing CLI option', 'duplicated CLI option'].includes(name)) {
      assert.equal(result.commands.some(command => command[0] === 'inspect'), false,
        name + ': must reject before Docker inspect');
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('Read-only live Docker wrapper: strict CLI, session identity, privacy and 14 negative scenarios PASS');
