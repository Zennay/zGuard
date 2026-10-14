// Loopback HTTP acceptance of the *shipped* /api/session handler. This
// verifies real Express response headers (not only mocked res.setHeader),
// without contacting a production gateway or starting a Docker browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { requireExactCachePrivacyFlag } from '../tools/cache-privacy-flags.mjs';

const strict = requireExactCachePrivacyFlag(process.argv.slice(2));
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const approvedSites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(Array.isArray(approvedSites) && approvedSites.length > 0,
  'source-tethered session test needs the reviewed gateway sites');
const allowedStart = approvedSites[0].url;

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'actual session route must remain extractable');
  return source.slice(start, end);
}
const handler = sourceBetween('function publicSession(', 'function validStartUrl(') +
  '\n' + sourceBetween('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"');

const app = express();
app.use(express.json({ limit: '8kb' }));
const ip = '127.0.0.1';
const token = 'T'.repeat(32); // synthetic, never a real bearer token
const session = {
  token, ip, expiresAt: Date.now() + 900_000, lastSeenAt: Date.now(),
  containerName: 'qa-fixture'
};
const sessions = new Map();
const sessionsByIp = new Map();
let starts = 0;
let released = 0;
let reservations = 0;
let rejectReason = null;
let failBrowserStart = false;
let logFailures = 0;
const sandbox = {
  app, sessionLimiter(_req, _res, next) { next(); },
  config: { ttlMs: 900_000, idleMs: 600_000 },
  sessions, sessionsByIp, requestIp, trustProxyHops: 0,
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected teardown in fresh session test'); },
  validStartUrl(value) { return value === allowedStart ? value : null; },
  sessionAdmission: {
    tryReserve() {
      if (rejectReason !== null) return { ok: false, reason: rejectReason };
      reservations++;
      return { ok: true };
    },
    release() { released++; }
  },
  async createSession(givenIp, startUrl) {
    assert.equal(givenIp, ip);
    assert.equal(startUrl, allowedStart);
    starts++;
    if (failBrowserStart) throw new Error('synthetic browser start failed');
    sessions.set(token, session);
    sessionsByIp.set(ip, token);
    return session;
  },
  console: { error() { logFailures++; } },
  Math, Date
};
vm.runInNewContext(handler, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const target = 'http://' + ip + ':' + server.address().port + '/api/session';
  const attempt = async (url = allowedStart, customHeaders) => {
    const response = await fetch(target, {
      method: 'POST',
      headers: customHeaders ?? { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(4000)
    });
    const payload = await response.json();
    return { status: response.status, cache: response.headers.get('cache-control'),
      payload };
  };
  const created = await attempt();
  const reused = await attempt();
  for (const result of [created, reused]) {
    assert.equal(result.payload.token, token,
      'successful session API responses must preserve the issued bearer');
    assert.equal(result.payload.viewerUrl, '/s/' + token + '/',
      'successful viewer URL must remain scoped to the issued token');
  }
  assert.deepEqual([created.status, reused.status], [201, 200],
    'real gateway handler must exercise both new and reused session response branches');
  assert.equal(starts, 1, 'session reuse must avoid a duplicate browser creation');
  assert.equal(reservations, 1, 'reused session must not consume another admission reservation');
  assert.equal(released, 1, 'new session must release admission reservation');

  // Test every source-bound session API failure response too. These are not
  // bearer-bearing success payloads, but shared caches must never turn
  // capacity failures or a rejected site into a stale session response.
  sessions.clear();
  sessionsByIp.clear();
  const invalid = await attempt('https://unreviewed.invalid/');
  assert.equal(invalid.status, 400, 'unreviewed origin must be denied before admission');
  assert.equal(invalid.payload.token, undefined,
    'invalid site failure must not return any session bearer');
  assert.equal(starts, 1);

  // Failure branches that execute BEFORE admission also carry session
  // metadata-sensitive context. Both must declare no-store over real HTTP.
  const unsupported = await attempt(allowedStart, {
    'content-type': 'text/plain'
  });
  assert.equal(unsupported.status, 415,
    'unsupported media type must be rejected without a browser allocation');
  assert.equal(unsupported.payload.token, undefined,
    'HTTP 415 must not return a session bearer');
  const crossSite = await attempt(allowedStart, {
    'content-type': 'application/json',
    origin: 'https://attacker.invalid',
    'sec-fetch-site': 'cross-site'
  });
  assert.equal(crossSite.status, 403,
    'cross-site JSON must be denied before session admission');
  assert.equal(crossSite.payload.token, undefined,
    'HTTP 403 must not disclose a browser bearer');
  assert.equal(starts, 1, 'denied requests must not launch additional browsers');
  assert.equal(reservations, 1, 'denied requests must not reserve container capacity');

  rejectReason = 'pending';
  const pending = await attempt();
  assert.equal(pending.status, 409,
    'duplicate in-flight request must not issue another browser');
  assert.equal(starts, 1);
  rejectReason = 'capacity';
  const full = await attempt();
  assert.equal(full.status, 503,
    'full capacity must be represented as unavailable, not a reusable session');
  assert.equal(starts, 1);
  rejectReason = null;

  failBrowserStart = true;
  const failed = await attempt();
  assert.equal(failed.status, 500, 'synthetic browser failure must be bounded');
  assert.equal(failed.payload.error, 'The browser could not be started.',
    'failed session startup must return only a generic message');
  assert.equal(logFailures, 1,
    'shipped route must record exactly one startup failure signal');
  assert.equal(released, 2, 'failed startup must also release the reserved slot');
  assert.equal(sessions.size, 0, 'failed browser startup must not publish a session');
  failBrowserStart = false;

  const responses = [created, reused, invalid, unsupported, crossSite, pending, full, failed];
  const noStore = responses.every(response => (
    typeof response.cache === 'string' &&
    response.cache.toLowerCase().split(',').map(x => x.trim()).includes('no-store')
  ));
  if (strict) {
    assert.equal(noStore, true,
      'HTTP POST /api/session 201/200/400/415/403/409/503/500 must each include Cache-Control: no-store (issue #284)');
    console.log('Real Express success and denial session HTTP cache policy PASS');
  } else {
    console.log('Shipped session route served 201/200 and 400/415/403/409/503/500 over local HTTP; ' +
      'all six no-store policies=' + noStore +
      ' (strict proof requires --require-no-store; issue #284 remains open)');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
