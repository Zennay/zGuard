// Source-bound HTTP proof: an in-flight browser start must be reconciled at shutdown.
// Uses actual shipped POST and shutdown, real localhost TCP, synthetic containers.
// Never sends a production signal, creates a Docker container or exits the CI worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-inflight-drain');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'shipped gateway routes must remain extractable');
  return source.slice(start, end);
}
const parser = source.match(/app\.use\(express\.json\(\{ limit: "8kb" \}\)\);/)?.[0];
assert.ok(parser, 'gateway must keep bounded JSON parsing');
const code = [
  parser,
  section('function publicSession(', 'function validStartUrl('),
  section('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"'),
  section('async function shutdown() {', 'process.on("SIGTERM"')
].join('\n') + '\nshutdown';

const app = express();
const server = http.createServer(app);
const ip = '127.0.0.1';
const token = 'I'.repeat(32); // fake, never a production bearer
const sessions = new Map();
const sessionsByIp = new Map();
let starts = 0;
let reserves = 0;
let releases = 0;
let destroyed = 0;
let completion;
let releaseStart;
let reportExit;
const created = new Promise(resolve => { completion = resolve; });
const shutDown = new Promise(resolve => { reportExit = resolve; });
const exitCodes = [];
const context = {
  app, express, Math, Date, sessions, sessionsByIp, requestIp, trustProxyHops: 0,
  config: { ttlMs: 900_000, idleMs: 600_000 },
  cleanupTimer: {},
  clearInterval() {},
  setTimeout(_callback, ms) {
    assert.equal(ms, 8000);
    return { unref() {} };
  },
  server,
  process: {
    exit(code) {
      exitCodes.push(code);
      reportExit();
    }
  },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  validStartUrl(url) { return url === 'https://fawesome.tv/' ? url : null; },
  sessionAdmission: {
    tryReserve() { reserves++; return { ok: true }; },
    release() { releases++; }
  },
  async createSession(owner, url) {
    assert.equal(owner, ip);
    assert.equal(url, 'https://fawesome.tv/');
    starts++;
    completion();
    return new Promise(resolve => {
      releaseStart = () => {
        const session = {
          ip: owner, token,
          expiresAt: Date.now() + 900_000,
          lastSeenAt: Date.now()
        };
        sessions.set(token, session);
        sessionsByIp.set(owner, token);
        resolve(session);
      };
    });
  },
  async destroySession(deletingToken) {
    destroyed++;
    const session = sessions.get(deletingToken);
    if (session) {
      sessions.delete(deletingToken);
      if (sessionsByIp.get(session.ip) === deletingToken) sessionsByIp.delete(session.ip);
    }
  },
  console: { error() { throw new Error('unexpected synthetic creation failure'); } }
};
const shutdown = vm.runInNewContext(code, context, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
await new Promise((resolve, reject) => {
  server.listen(0, ip, resolve);
  server.once('error', reject);
});
const endpoint = 'http://' + ip + ':' + server.address().port + '/api/session';
let responseStatus = null;
try {
  const pendingResponse = fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ url: 'https://fawesome.tv/' }),
    signal: AbortSignal.timeout(8000)
  });
  await Promise.race([
    created,
    new Promise((_, reject) => setTimeout(() =>
      reject(new Error('in-flight request never entered browser creation')), 2000))
  ]);
  const shutdownWork = shutdown();
  // The current shutdown uses an immediate empty-session snapshot; allow
  // that microtask to complete before releasing the in-flight creation.
  await shutdownWork;
  releaseStart();
  const reply = await pendingResponse;
  responseStatus = reply.status;
  await reply.arrayBuffer();
  // The synthetic HTTP client must not hold an idle keep-alive socket open
  // and thereby delay Node's real server.close completion callback.
  server.closeIdleConnections?.();
  await Promise.race([
    shutDown,
    new Promise((_, reject) => setTimeout(() =>
      reject(new Error('shutdown listener close callback timed out')), 4000))
  ]);
} finally {
  releaseStart?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
assert.equal(reserves, releases, 'pending admissions must release their quota reservation');
assert.equal(starts, 1, 'fixture must prove one genuinely in-flight browser startup');
assert.deepEqual(exitCodes, [0], 'fixture must complete graceful shutdown');
const orphan = sessions.has(token);
const ownerOrphan = sessionsByIp.get(ip) === token;
if (strict) {
  assert.deepEqual({ orphan, ownerOrphan }, { orphan: false, ownerOrphan: false },
    'browser created during shutdown must be reconciled before exit (issue #7)');
  console.log('Actual gateway reconciled in-flight browser startup at shutdown');
} else {
  console.log('Actual gateway in-flight startup during shutdown: response=' +
    responseStatus + ', starts=' + starts + ', destroyCalls=' + destroyed +
    ', orphan=' + orphan + ', ownerOrphan=' + ownerOrphan +
    '; strict proof requires --require-inflight-drain; issue #7 remains open');
}
