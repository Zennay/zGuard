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
const sandbox = {
  app, sessionLimiter(_req, _res, next) { next(); },
  config: { ttlMs: 900_000, idleMs: 600_000 },
  sessions, sessionsByIp, requestIp, trustProxyHops: 0,
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected teardown in fresh session test'); },
  validStartUrl(value) { return value === allowedStart ? value : null; },
  sessionAdmission: {
    tryReserve() { reservations++; return { ok: true }; },
    release() { released++; }
  },
  async createSession(givenIp, startUrl) {
    assert.equal(givenIp, ip);
    assert.equal(startUrl, allowedStart);
    starts++;
    sessions.set(token, session);
    sessionsByIp.set(ip, token);
    return session;
  },
  console: { error() { throw new Error('unexpected session creation error'); } },
  Math, Date
};
vm.runInNewContext(handler, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const target = 'http://' + ip + ':' + server.address().port + '/api/session';
  const attempt = async () => {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: allowedStart }),
      signal: AbortSignal.timeout(4000)
    });
    const payload = await response.json();
    assert.equal(payload.token, token, 'actual HTTP response must preserve session identity');
    assert.equal(payload.viewerUrl, '/s/' + token + '/', 'session viewer URL must remain scoped');
    return { status: response.status, cache: response.headers.get('cache-control') };
  };
  const created = await attempt();
  const reused = await attempt();
  assert.deepEqual([created.status, reused.status], [201, 200],
    'real gateway handler must exercise both new and reused session response branches');
  assert.equal(starts, 1, 'session reuse must avoid a duplicate browser creation');
  assert.equal(reservations, 1, 'reused session must not consume another admission reservation');
  assert.equal(released, 1, 'new session must release admission reservation');

  const noStore = [created, reused].every(response => (
    typeof response.cache === 'string' &&
    response.cache.toLowerCase().split(',').map(x => x.trim()).includes('no-store')
  ));
  if (strict) {
    assert.equal(noStore, true,
      'actual HTTP POST /api/session 201/200 must both include Cache-Control: no-store (issue #284)');
    console.log('Real Express 201/200 token-bearing HTTP cache policy PASS');
  } else {
    console.log('Shipped session route served 201 and reused 200 over local HTTP; ' +
      'both token-bearing no-store policies=' + noStore +
      ' (strict proof requires --require-no-store; issue #284 remains open)');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
