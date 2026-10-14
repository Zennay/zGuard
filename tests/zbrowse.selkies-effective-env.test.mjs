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
