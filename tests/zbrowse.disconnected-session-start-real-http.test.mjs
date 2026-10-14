// Real localhost HTTP regression for a client disconnect during shipped session admission.
// Exercises the actual POST handler; browser creation is a deterministic in-memory
// stand-in. This never starts Docker, reaches the VPS or uses a live browser token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { createSessionAdmission } from '../zbrowse/gateway/session-admission.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2),
  '--require-disconnect-reconciliation');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function segment(begin, end) {
  const from = source.indexOf(begin);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'actual gateway handler must be available');
  return source.slice(from, to);
}
const app = express();
app.set('trust proxy', false);
app.use(express.json({ limit: '8kb' }));
const ip = '127.0.0.1';
const startUrl = 'https://fawesome.tv/';
const token = 'Q'.repeat(32); // synthetic-only, never a deployed credential
const config = { startUrl, maxSessions: 1, ttlMs: 900_000, idleMs: 300_000 };
const allowedOrigins = new Set([new URL(startUrl).origin]);
const sessionAdmission = createSessionAdmission(config.maxSessions);
const sessions = new Map();
const sessionsByIp = new Map();
let creations = 0;
let cleanups = 0;
let resolveStart;
let notifyStarting;
const started = new Promise(resolve => { notifyStarting = resolve; });
const closed = [];
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/session') {
    res.on('close', () => closed.push(!res.writableEnded));
  }
  next();
});
const sandbox = {
  app, requestIp, trustProxyHops: 0, config, allowedOrigins,
  sessions, sessionsByIp, sessionAdmission,
  isSessionExpired() { return false; },
  sessionLimiter(_req, _res, next) { next(); }, // rate limit is not the tested boundary
  async createSession(owner, url) {
    assert.equal(owner, ip);
    assert.equal(url, startUrl);
    creations++;
    notifyStarting();
    await new Promise(resolve => { resolveStart = resolve; });
    const session = {
      token, ip: owner, expiresAt: Date.now() + 900_000,
      lastSeenAt: Date.now()
    };
    sessions.set(token, session);
    sessionsByIp.set(owner, token);
    return session;
  },
  async destroySession(value) {
    cleanups++;
    sessions.delete(value);
    sessionsByIp.delete(ip);
  },
  console: { error(...args) { throw new Error('unexpected session creation failure'); } }
};
const handlers = [
  segment('function publicSession(session) {', 'async function waitForBrowser('),
  segment('app.get("/api/health", (req, res) => {', 'app.get("/api/sites",'),
  segment('app.post("/api/session", sessionLimiter, async (req, res) => {',
    'app.post("/api/session/:token/heartbeat",')
].join('\n');
assert.match(handlers, /const admission = sessionAdmission\.tryReserve/,
  'test must exercise the shipped reservation and release path');
vm.runInNewContext(handlers, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });

const server = await new Promise((resolve, reject) => {
  const listener = app.listen(0, ip, () => resolve(listener));
  listener.once('error', reject);
});
const endpoint = 'http://' + ip + ':' + server.address().port;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail('local disconnected-start fixture timed out: ' + label);
}
try {
  const req = http.request(endpoint + '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    agent: false
  });
  // A real client abort is expected to raise ECONNRESET on the caller. The
  // source-bound gateway must independently decide what happens to the
  // browser allocation, rather than relying on receiving a token response.
  req.on('error', error => {
    assert.ok(['ECONNRESET', 'EPIPE'].includes(error.code),
      'only the deliberately closed request may fail');
  });
  req.end(JSON.stringify({ url: startUrl }));
  await Promise.race([
    started,
    sleep(4000).then(() => { throw new Error('gateway did not start synthetic browser'); })
  ]);
  assert.equal(creations, 1, 'shipped POST route must reserve and start one session');
  assert.equal(sessionAdmission.pendingCount, 1,
    'start must still hold the capacity reservation before completion');
  assert.equal(sessions.size, 0,
    'browser is not allocated until the controlled create operation returns');
  req.destroy();
  await until(() => closed.length === 1 && closed[0] === true,
    'server must witness actual HTTP response socket close before session creation');
  resolveStart();
  await until(() => sessionAdmission.pendingCount === 0,
    'server-side start finishes despite client disconnect');
  // Allow any asynchronous server-side cancellation callback to finish.
  await sleep(60);
  const retainedAfterAbort = sessions.size;
  const health = await fetch(endpoint + '/api/health',
    { signal: AbortSignal.timeout(3000) });
  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.capacity, 1);
  assert.equal(status.activeSessions, retainedAfterAbort,
    'actual health route must reflect server-owned session registry');
  if (strict) {
    assert.equal(retainedAfterAbort, 0,
      'a disconnected start must not retain an unreachable browser allocation');
    assert.ok(cleanups >= 1,
      'disconnect reconciliation must execute a real cleanup attempt');
  } else {
    assert.equal(retainedAfterAbort, 1,
      'shipped baseline currently retains the browser after the client leaves');
    assert.equal(cleanups, 0,
      'shipped baseline has no disconnected-request reclaim');
    // Positive control: same-IP recovery is currently possible, although
    // it cannot repair lost capacity for clients who never return.
    const retry = await fetch(endpoint + '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: startUrl }),
      signal: AbortSignal.timeout(3000)
    });
    assert.equal(retry.status, 200,
      'same-owner retry currently reuses the orphan after disconnect');
    const reused = await retry.json();
    assert.equal(reused.token, token);
    assert.equal(creations, 1, 'reconnection must not create a second browser');
  }
  console.log('Shipped real HTTP aborted-start acceptance: browser allocations=' +
    creations + ', retained after disconnect=' + retainedAfterAbort +
    ', cleanup attempts=' + cleanups +
    '; strict remediation proof: --require-disconnect-reconciliation');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
