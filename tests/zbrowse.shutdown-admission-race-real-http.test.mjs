// Actual shipped Express POST route raced against the shipped shutdown().
// Uses real 127.0.0.1 HTTP and deterministic fake Docker teardown only.
// Baseline is a truthful probe; strict mode requires issue #7 runtime repair.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-shutdown-drain');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'real gateway route and shutdown must be extractable');
  return source.slice(start, end);
}
const parser = source.match(/app\.use\(express\.json\(\{ limit: "8kb" \}\)\);/)?.[0];
assert.ok(parser, 'gateway must retain a bounded JSON parser');
const handler = [
  parser,
  section('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"'),
  section('async function shutdown() {', 'process.on("SIGTERM"')
].join('\n') + '\nshutdown';

const app = express();
const server = http.createServer(app);
const oldToken = 'O'.repeat(32);
const newToken = 'N'.repeat(32);
const ip = '127.0.0.1';
const oldOwner = '198.51.100.77';
const sessions = new Map([[oldToken, { token: oldToken, ip: oldOwner }]]);
const sessionsByIp = new Map([[oldOwner, oldToken]]);
let teardownEntered;
const entered = new Promise(resolve => { teardownEntered = resolve; });
let finishTeardown;
let starts = 0;
let reserves = 0;
let releases = 0;
const exitCodes = [];

const context = {
  app, express, sessions, sessionsByIp, requestIp, trustProxyHops: 0,
  config: { ttlMs: 900_000, idleMs: 600_000 },
  cleanupTimer: {},
  clearInterval() {},
  setTimeout(_callback, milliseconds) {
    assert.equal(milliseconds, 8000, 'shutdown safety timer must remain bounded');
    return { unref() {} };
  },
  server,
  process: { exit(code) { exitCodes.push(code); } },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  validStartUrl(value) { return value === 'https://fawesome.tv/' ? value : null; },
  sessionAdmission: {
    tryReserve() { reserves++; return { ok: true }; },
    release() { releases++; }
  },
  async createSession(owner, target) {
    assert.equal(owner, ip);
    assert.equal(target, 'https://fawesome.tv/');
    starts++;
    const newSession = { token: newToken, ip: owner,
      expiresAt: Date.now() + 900_000, lastSeenAt: Date.now() };
    sessions.set(newToken, newSession);
    sessionsByIp.set(owner, newToken);
    return newSession;
  },
  async destroySession(token) {
    if (token === oldToken) {
      teardownEntered();
      await new Promise(resolve => { finishTeardown = resolve; });
    }
    const previous = sessions.get(token);
    if (previous) {
      sessions.delete(token);
      if (sessionsByIp.get(previous.ip) === token) sessionsByIp.delete(previous.ip);
    }
  },
  console: { error() { throw new Error('unexpected browser startup failure'); } }
};
const shutdown = vm.runInNewContext(handler, context, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
const listening = new Promise((resolve, reject) => {
  server.listen(0, ip, resolve);
  server.once('error', reject);
});
await listening;
const endpoint = 'http://' + ip + ':' + server.address().port + '/api/session';
let status = null;
let rejectedByClosedListener = false;
let shutdownPromise;
try {
  shutdownPromise = shutdown();
  await Promise.race([
    entered,
    new Promise((_, reject) => setTimeout(() =>
      reject(new Error('shutdown never entered old-session cleanup')), 2000))
  ]);
  try {
    const reply = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://fawesome.tv/' }),
      signal: AbortSignal.timeout(2500)
    });
    status = reply.status;
    await reply.arrayBuffer();
  } catch (error) {
    if (error?.name === 'TypeError' && !server.listening) {
      rejectedByClosedListener = true;
    } else {
      throw error;
    }
  }
} finally {
  finishTeardown?.();
  if (shutdownPromise) await shutdownPromise;
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
assert.equal(reserves, releases, 'admission reservations must remain balanced');
assert.ok(exitCodes.length >= 1, 'shutdown must complete its mocked process exit callback');
const rejected = rejectedByClosedListener || (status !== null && status >= 400);
const orphan = sessions.has(newToken);
if (strict) {
  assert.equal(rejected && starts === 0 && !orphan, true,
    'session POST racing shutdown must be drained/rejected before browser creation (issue #7)');
  console.log('Real localhost HTTP shutdown-admission race is fail-closed');
} else {
  console.log('Actual gateway shutdown/HTTP admission race: requestStatus=' +
    (status ?? 'listener-closed') + ', browserStarts=' + starts +
    ', unmanagedLateSession=' + orphan +
    ', rejectedBeforeCreation=' + rejected +
    '. Strict proof requires --require-shutdown-drain; issue #7 remains open');
}
