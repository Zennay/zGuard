// This tests the disjoint logging helper only. Gateway integration is owned by
// the active runtime PR; passing this test is not production sanitization.
import assert from 'node:assert/strict';
import { format } from 'node:util';
import { safeStartErrorCategory } from '../zbrowse/gateway/safe-start-error.js';

const SECRET = 'fake-browser-start-bearer-' + 'X'.repeat(32);
const canary = new Error('Docker Env PASSWORD=synthetic-pass /s/' + SECRET + '/');
canary.cause = new Error('Authorization: Basic c3ludGhldGlj');
canary.request = { uri: 'https://username:password@example.invalid/s/' + SECRET };
canary.code = SECRET;
const unsafeNativeError = format('Session creation failed', canary);
assert.ok(unsafeNativeError.includes(SECRET), 'negative control must expose test canary');
assert.equal(safeStartErrorCategory(canary), 'BROWSER_START_FAILURE');
for (const example of [null, undefined, false, 4, 'ETIMEDOUT', ['EPIPE'], {},
                       Object.create({ code: 'ETIMEDOUT' })]) {
  assert.equal(safeStartErrorCategory(example), 'BROWSER_START_FAILURE',
    'untrusted non-own code must not influence diagnostics');
}
for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
                    'ENOSPC', 'EACCES', 'ENOENT']) {
  assert.equal(safeStartErrorCategory(Object.assign(new Error('private:' + SECRET), { code })),
    code);
}
for (const code of ['ETIMEDOUT\nfake-ready', '\u001b[2J', 'PASSWORD=' + SECRET,
                    'ECONNREFUSED' + SECRET, 'ERR_DOCKER_' + SECRET]) {
  assert.equal(safeStartErrorCategory({ code }), 'BROWSER_START_FAILURE');
}
const accessors = {};
Object.defineProperty(accessors, 'code', {
  enumerable: true,
  get() { throw new Error('a malicious logging accessor must never run'); }
});
assert.equal(safeStartErrorCategory(accessors), 'BROWSER_START_FAILURE');
let getterCalled = 0;
const descriptor = {};
Object.defineProperty(descriptor, 'code', { get() { getterCalled++; return 'EPIPE'; } });
assert.equal(safeStartErrorCategory(descriptor), 'BROWSER_START_FAILURE');
assert.equal(getterCalled, 0);
const throwingProxy = new Proxy({}, {
  getOwnPropertyDescriptor() { throw new Error('synthetic proxy trap'); }
});
assert.equal(safeStartErrorCategory(throwingProxy), 'BROWSER_START_FAILURE');
const recorded = [
  format('Session creation failed', safeStartErrorCategory(canary)),
  format('Session creation failed', safeStartErrorCategory(accessors)),
  format('Session creation failed', safeStartErrorCategory(throwingProxy)),
];
for (const line of recorded) {
  assert.ok(line.startsWith('Session creation failed '));
  assert.doesNotMatch(line, /PASSWORD|Authorization|Basic|\x1b|\n|\r|synthetic|username|password|X{32}|Bearer|\//);
  assert.ok(line.length < 80);
}
console.log('zBrowse startup-error diagnostic helper: 7 reviewed codes, opaque errors, accessor traps and synthetic credential canaries PASS (helper only; runtime owner integration pending)');
