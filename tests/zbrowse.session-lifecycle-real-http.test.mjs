// Real loopback HTTP security acceptance of shipped heartbeat + teardown
// endpoints; synthetic session tokens only, no Docker or public requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { requireExactCachePrivacyFlag } from '../tools/cache-privacy-flags.mjs';

const strictNoStore = requireExactCachePrivacyFlag(process.argv.slice(2));

const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
// Execute token-wide middleware too: method-denied/OPTIONS requests bypass
// POST/DELETE route handlers but still contain a bearer in the URL.
const first = source.indexOf('app.use("/api/session/:token"');
const last = source.indexOf('app.use("/s/",', first);
assert.ok(first >= 0 && last > first,
  'production heartbeat and delete handlers must remain extractable');
const app = express();
const token = 'H'.repeat(32);
const ip = '127.0.0.1';
const initialTime = 1000;
const session = {
  token, ip, lastSeenAt: initialTime,
  expiresAt: Date.now() + 600_000,
  expired: false
};
const sessions = new Map([[token, session]]);
const sessionsByIp = new Map([[ip, token]]);
let destroys = 0;
const sandbox = {
  app, sessions, sessionsByIp, requestIp,
  trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired(value) { return Boolean(value.expired); },
  async destroySession(givenToken) {
    destroys++;
    assert.equal(givenToken, token, 'teardown must only delete the requested bearer');
    sessions.delete(givenToken);
    sessionsByIp.delete(ip);
  },
  Date
};
vm.runInNewContext(source.slice(first, last), sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});

try {
  const bearerPathResponses = [];
  const request = async (method, bearer, headers = {}) => {
    const url = 'http://' + ip + ':' + server.address().port +
      '/api/session/' + bearer + (method === 'POST' ? '/heartbeat' : '');
    const response = await fetch(url, {
      method, headers, signal: AbortSignal.timeout(4000)
    });
    const text = await response.text();
    const result = { status: response.status, body: text,
      cache: response.headers.get('cache-control') };
    bearerPathResponses.push({ method, status: result.status, cache: result.cache });
    return result;
  };

  // HTTP method confusion must not extend or destroy a bearer session.
  // Run the shipped Express router over actual loopback HTTP on both lease
  // and deletion URLs; even OPTIONS must not mutate the session or counters.
  let rejectedMethodCount = 0;
  for (const suffix of ['', '/heartbeat']) {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'OPTIONS']) {
      const response = await fetch('http://' + ip + ':' + server.address().port +
        '/api/session/' + token + suffix, {
        method, redirect: 'error', signal: AbortSignal.timeout(4000)
      });
      const body = await response.text();
      if (method === 'OPTIONS') {
        assert.equal(response.status, 200,
          'Express should advertise supported methods without touching a session');
      } else {
        assert.equal(response.status, 404,
          method + ' must not be mapped to a destructive token route');
        rejectedMethodCount++;
      }
      if (method === 'HEAD') {
        assert.equal(body, '', 'rejected HEAD must never return a body');
      }
      bearerPathResponses.push({ method, status: response.status,
        cache: response.headers.get('cache-control') });
      assert.equal(session.lastSeenAt, initialTime,
        method + ' must not renew a session without POST /heartbeat');
      assert.equal(destroys, 0,
        method + ' must never tear down the browser without DELETE /:token');
      assert.equal(sessions.get(token), session,
        method + ' must keep the existing session intact');
    }
  }
  assert.equal(rejectedMethodCount, 8,
    'both bearer endpoints must reject all four unsupported HTTP methods');

  for (const method of ['POST', 'DELETE']) {
    const unknown = await request(method, 'X'.repeat(32));
    assert.equal(unknown.status, 404,
      method + ': missing bearer must fail without revealing session existence');
    assert.equal(destroys, 0);
    assert.equal(sessions.has(token), true);
  }
  // Session ownership comes from the real TCP peer, not user-supplied XFF.
  session.ip = '192.0.2.44';
  const spoofHeaders = { 'x-forwarded-for': '192.0.2.44' };
  for (const method of ['POST', 'DELETE']) {
    const stolen = await request(method, token, spoofHeaders);
    assert.equal(stolen.status, 404,
      method + ': forged client IP must not authorize another browser session');
    assert.equal(session.lastSeenAt, initialTime,
      method + ': invalid caller must not extend session lease');
    assert.equal(destroys, 0,
      method + ': invalid caller must not destroy the session');
  }
  session.ip = ip;

  session.expired = true;
  for (const method of ['POST', 'DELETE']) {
    const expired = await request(method, token);
    assert.equal(expired.status, 404, method + ': expired bearer must fail closed');
    assert.equal(destroys, 0);
  }
  session.expired = false;

  const heartbeat = await request('POST', token);
  assert.equal(heartbeat.status, 200, 'session owner can heartbeat over real HTTP');
  assert.equal(JSON.parse(heartbeat.body).ok, true);
  assert.equal(JSON.parse(heartbeat.body).expiresAt, session.expiresAt,
    'session heartbeat cannot silently change absolute expiry');
  assert.ok(session.lastSeenAt > initialTime,
    'valid owner heartbeat must extend the inactivity lease');
  assert.equal(destroys, 0, 'heartbeat must not destroy a valid session');

  const ended = await request('DELETE', token);
  assert.equal(ended.status, 204, 'session owner can end the session over HTTP');
  assert.equal(ended.body, '', 'HTTP 204 teardown must never return bearer contents');
  assert.equal(destroys, 1, 'explicit close must destroy exactly one session');
  assert.equal(sessions.has(token), false, 'ended session must no longer exist');
  assert.equal(sessionsByIp.size, 0, 'explicit close must release IP ownership');

  for (const method of ['POST', 'DELETE']) {
    const repeat = await request(method, token);
    assert.equal(repeat.status, 404, 'ended session must never be reusable');
    assert.equal(destroys, 1, 'repeat close/heartbeat must not double-destroy');
  }
  // Even a 204 response is heuristically cacheable under HTTP rules, and the
  // request path itself contains the session bearer. Require no-store for
  // success, denial, expiry and already-deleted paths under strict privacy.
  const hasNoStore = cache => {
    const directives = String(cache || '').toLowerCase()
      .split(',').map(item => item.trim());
    return directives.includes('no-store') && !directives.includes('public');
  };
  const safeCount = bearerPathResponses.filter(row => hasNoStore(row.cache)).length;
  if (strictNoStore) {
    assert.equal(safeCount, bearerPathResponses.length,
      'heartbeat and DELETE bearer-URL responses (200, 204, 404) must all prohibit storage');
  }
  console.log('Real HTTP heartbeat + teardown token/IP/expiry isolation passed; ' +
    'bearer-path no-store=' + safeCount + '/' + bearerPathResponses.length +
    ' (strict requires --require-no-store)');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
