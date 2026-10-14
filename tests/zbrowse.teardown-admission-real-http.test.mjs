// HTTP-level admission acceptance using the shipped session teardown and
// POST route. Docker containers are deterministic failing test doubles;
// HTTP listens on loopback only, never on production/VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-fail-closed');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(sites.length > 0, 'gateway site allowlist must be available');
const approvedUrl = sites[0].url;
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'shipped teardown and admission code must be extractable');
  return source.slice(start, end);
}
const sourceCode = [
  section('function publicSession(', 'function validStartUrl('),
  section('async function stopContainer(', 'async function createSession('),
  section('async function destroySession(', 'function findSession('),
  section('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"')
].join('\n');

async function scenario({ stopFails, removeFails }) {
  const ip = '127.0.0.1';
  const expiredToken = 'E'.repeat(32); // synthetic, never a bearer
  const newToken = 'N'.repeat(32);
  let stops = 0;
  let removals = 0;
  let starts = 0;
  let releases = 0;
  const oldSession = {
    token: expiredToken, ip,
    container: {
      async stop(options) {
        stops++;
        assert.equal(options.t, 3, 'actual gateway must keep bounded stop');
        if (stopFails) throw new Error('synthetic stop failure');
      },
      async remove(options) {
        removals++;
        assert.equal(options.force, true);
        if (removeFails) throw new Error('synthetic force-removal failure');
      }
    },
    expiresAt: Date.now() - 1000, lastSeenAt: Date.now() - 1000
  };
  const sessions = new Map([[expiredToken, oldSession]]);
  const sessionsByIp = new Map([[ip, expiredToken]]);
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  const sandbox = {
    app, sessions, sessionsByIp,
    requestIp, trustProxyHops: 0,
    config: { ttlMs: 900_000, idleMs: 600_000 },
    sessionLimiter(_req, _res, next) { next(); },
    isSessionExpired(session) { return session === oldSession; },
    validStartUrl(value) { return value === approvedUrl ? value : null; },
    sessionAdmission: {
      tryReserve(_ip, currentCount) {
        if (currentCount >= 1) return { ok: false, reason: 'capacity' };
        return { ok: true };
      },
      release() { releases++; }
    },
    async createSession(requestIpValue, url) {
      assert.equal(requestIpValue, ip);
      assert.equal(url, approvedUrl);
      starts++;
      const session = {
        token: newToken, ip, expiresAt: Date.now() + 900_000,
        lastSeenAt: Date.now()
      };
      sessions.set(newToken, session);
      sessionsByIp.set(ip, newToken);
      return session;
    },
    console: { error() { throw new Error('unexpected creation failure'); } },
    Math, Date
  };
  vm.runInNewContext(sourceCode, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, ip, () => resolve(listening));
    listening.once('error', reject);
  });
  try {
    const reply = await fetch('http://' + ip + ':' + server.address().port +
      '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: approvedUrl }),
      signal: AbortSignal.timeout(4000)
    });
    await reply.arrayBuffer();
    return {
      status: reply.status, stops, removals, starts, releases,
      oldTracked: sessions.has(expiredToken),
      ownerRetained: sessionsByIp.get(ip) === expiredToken,
      newTracked: sessions.has(newToken),
      newOwnerSet: sessionsByIp.get(ip) === newToken,
      capacityUsed: sessions.size
    };
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}

// Graceful cleanup must not invoke the force-removal fallback, must free
// exactly the expired owner's slot and admit one replacement with no orphan.
const graceful = await scenario({ stopFails: false, removeFails: false });
assert.deepEqual({
  status: graceful.status, stops: graceful.stops, removals: graceful.removals,
  starts: graceful.starts, releases: graceful.releases,
  oldTracked: graceful.oldTracked, ownerRetained: graceful.ownerRetained,
  newTracked: graceful.newTracked, newOwnerSet: graceful.newOwnerSet,
  capacityUsed: graceful.capacityUsed
}, {
  status: 201, stops: 1, removals: 0, starts: 1, releases: 1,
  oldTracked: false, ownerRetained: false,
  newTracked: true, newOwnerSet: true, capacityUsed: 1
}, 'graceful expired browser removal must free only the original slot');

const recovered = await scenario({ stopFails: true, removeFails: false });
assert.equal(recovered.status, 201, 'successful forced cleanup must allow one replacement');
assert.equal(recovered.stops, 1);
assert.equal(recovered.removals, 1);
assert.equal(recovered.starts, 1);
assert.equal(recovered.oldTracked, false, 'successfully removed session frees capacity');
assert.equal(recovered.newTracked, true, 'forced cleanup recovery must publish one new session');
assert.equal(recovered.newOwnerSet, true,
  'forced cleanup replacement must register correct new owner');
assert.equal(recovered.releases, 1,
  'forced cleanup must release its one successful replacement reservation');

const orphan = await scenario({ stopFails: true, removeFails: true });
assert.equal(orphan.stops, 1, 'failed teardown must attempt graceful stop');
assert.equal(orphan.removals, 1, 'failed teardown must attempt forced removal');
assert.equal(orphan.newTracked, !orphan.oldTracked,
  'orphan scenario must never contain both the old and a new live browser');
assert.equal(orphan.releases, orphan.starts,
  'orphan scenario must keep reservation release accounting balanced');
const protectedCapacity = orphan.oldTracked && orphan.ownerRetained &&
  orphan.capacityUsed >= 1 && orphan.starts === 0 && orphan.status >= 400;

if (strict) {
  assert.equal(protectedCapacity, true,
    'failed stop AND removal must not admit a second real HTTP browser session (issue #7)');
  console.log('Shipped HTTP session admission fails closed after container teardown failure');
} else {
  console.log('Actual gateway HTTP teardown paths exercised: fallback cleanup recovered; ' +
    'graceful-stop recovered=true, forced-stop recovered=' + recovered.newOwnerSet +
    ', failed-stop-and-remove protectedCapacity=' + protectedCapacity +
    ' (strict proof requires --require-fail-closed; issue #7 remains open)');
}
