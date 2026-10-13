// Execute the shipped session route with controlled dependencies. This is
// handler-level evidence, NOT an HTTP/proxy/VPS acceptance for issue #284.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { requireExactCachePrivacyFlag } from '../tools/cache-privacy-flags.mjs';

const requireNoStore = requireExactCachePrivacyFlag(process.argv.slice(2));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gateway = fs.readFileSync(path.join(root, 'zbrowse/gateway/server.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = gateway.indexOf(startMarker);
  const end = gateway.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start,
    'session API route must remain extractable from the real gateway source');
  return gateway.slice(start, end);
}

const publicSessionSource = sourceBetween('function publicSession(', 'function validStartUrl(');
const routeSource = sourceBetween(
  'app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"'
);

const ip = '192.0.2.14'; // RFC 5737 documentation-only fixture
const fakeToken = 'A'.repeat(32);
const fixture = {
  token: fakeToken,
  ip,
  expiresAt: Date.now() + 600_000,
  lastSeenAt: Date.now(),
  containerName: 'fixture-only'
};
const sessions = new Map();
const sessionsByIp = new Map();
let createCalls = 0;
let releaseCalls = 0;
let route;

const sandbox = {
  app: {
    post(url, limiter, handler) {
      assert.equal(url, '/api/session', 'test must execute the actual session URL');
      assert.equal(typeof handler, 'function', 'session route must be executable');
      assert.equal(typeof limiter, 'function', 'existing session rate limiter must remain wired');
      route = handler;
    }
  },
  sessionLimiter() {},
  sessions,
  sessionsByIp,
  requestIp: () => ip,
  trustProxyHops: 0,
  isSessionExpired: () => false,
  destroySession: async () => { throw new Error('unexpected teardown'); },
  validStartUrl: () => 'https://reviewed.example/watch',
  sessionAdmission: {
    pendingCount: 0,
    tryReserve: () => ({ ok: true }),
    release() { releaseCalls += 1; }
  },
  createSession: async () => { createCalls += 1; return fixture; },
  config: { ttlMs: 900_000 },
  console: { error() { throw new Error('unexpected gateway failure'); } },
  Date
};
vm.runInNewContext(publicSessionSource + '\n' + routeSource, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
assert.equal(typeof route, 'function', 'actual session route must be registered');

function responseCapture() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); return this; },
    header(name, value) { return this.setHeader(name, value); },
    set(name, value) {
      if (typeof name === 'object') {
        for (const [key, entry] of Object.entries(name)) this.setHeader(key, entry);
        return this;
      }
      return this.setHeader(name, value);
    },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
function assertTokenResponse(res, expectedStatus, label) {
  assert.equal(res.statusCode, expectedStatus, label + ': status must not regress');
  assert.equal(res.body?.token, fakeToken, label + ': returned session identity must be intact');
  assert.equal(res.body?.viewerUrl, '/s/' + fakeToken + '/',
    label + ': viewer URL must remain tied to the bearer session');
}
function assertNotStorable(res, label) {
  const policy = String(res.getHeader('Cache-Control') || '').toLowerCase();
  const directives = policy.split(',').map((part) => part.trim());
  assert.ok(directives.includes('no-store'),
    label + ': session-bearing API response needs explicit Cache-Control: no-store (issue #284)');
}

sessions.set(fakeToken, fixture);
sessionsByIp.set(ip, fakeToken);
const existing = responseCapture();
await route({ body: { url: 'https://reviewed.example/watch' } }, existing);
assertTokenResponse(existing, 200, 'reused session');
assert.equal(createCalls, 0, 'reusing an existing session must not create a container');
assert.equal(releaseCalls, 0, 'reusing an existing session must not reserve capacity');

sessions.clear();
sessionsByIp.clear();
const created = responseCapture();
await route({ body: { url: 'https://reviewed.example/watch' } }, created);
assertTokenResponse(created, 201, 'new session');
assert.equal(createCalls, 1, 'new-session branch must invoke the actual creation dependency');
assert.equal(releaseCalls, 1, 'new-session branch must release the admission reservation');

if (requireNoStore) {
  // Both paths are necessary: a response policy installed only after
  // createSession would leave the faster reused-session path unprotected.
  const failures = [];
  for (const [label, captured] of [['reused session 200', existing], ['new session 201', created]]) {
    try { assertNotStorable(captured, label); }
    catch { failures.push(label + ': no no-store policy'); }
  }
  assert.deepEqual(failures, [],
    'Actual session route lacks a no-store header (issue #284): ' + failures.join('; '));
  console.log('Gateway session API no-store PASS for 200 and 201');
} else {
  console.log('Actual gateway session route exercised for reused 200 and new 201; ' +
    'token-bearing no-store enforcement requires --require-no-store');
}
