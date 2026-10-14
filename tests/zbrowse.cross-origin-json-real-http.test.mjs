// Source-tethered HTTP check: valid JSON does not by itself establish
// that a cross-site caller may allocate or reuse a token-bearing session.
// Deliberately uses synthetic Docker operations and local 127.0.0.1 only.
// A browser normally preflights cross-origin application/json; this check
// establishes server-side authorization defense-in-depth, NOT preflight bypass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-origin-isolation');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const helmet = require('helmet');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(Array.isArray(sites) && sites.length > 0, 'reviewed start site required');
function section(begin, end) {
  const a = source.indexOf(begin);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'shipped gateway route must remain extractable');
  return source.slice(a, b);
}
const middleware = section('app.set("trust proxy", trustProxyHops);',
  'const sessionLimiter = rateLimit(');
assert.ok(middleware.includes('app.use(express.json({ limit: "8kb" }));'),
  'real gateway must retain a bounded JSON parser');
const code = [
  middleware,
  section('const allowedOrigins = new Set(', 'const trustProxyHops'),
  section('function publicSession(', 'function validStartUrl('),
  section('function validStartUrl(', 'async function waitForBrowser('),
  section('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"')
].join('\n');

const app = express();
const peer = '127.0.0.1';
const sessions = new Map();
const sessionsByIp = new Map();
let starts = 0;
let reservations = 0;
let releases = 0;
const sandbox = {
  app, express, helmet, sites, URL, Date, Math, requestIp, trustProxyHops: 0,
  sessions, sessionsByIp,
  config: { startUrl: sites[0].url, ttlMs: 900_000, idleMs: 600_000 },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected teardown'); },
  sessionAdmission: {
    tryReserve() { reservations++; return { ok: true }; },
    release() { releases++; }
  },
  async createSession(ip, startUrl) {
    assert.equal(ip, peer);
    assert.equal(startUrl, sites[0].url);
    starts++;
    const session = {
      ip, token: 'S'.repeat(32),
      expiresAt: Date.now() + 900_000, lastSeenAt: Date.now()
    };
    sessions.set(session.token, session);
    sessionsByIp.set(ip, session.token);
    return session;
  },
  console: { error() { throw new Error('unexpected browser creation failure'); } }
};
vm.runInNewContext(code, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, peer, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const sameOrigin = 'http://' + peer + ':' + server.address().port;
  // This is the reviewed public TV frontend origin in the read-only public
  // readiness contract. Real reverse proxies forward this Origin to gateway.
  const publicTvOrigin = 'https://zbrowse-tv.lizellay.chatgpt.site';
  async function post({ origin, fetchSite, preserve = false }) {
    if (!preserve) {
      sessions.clear();
      sessionsByIp.clear();
    }
    const previousStarts = starts;
    const previousReserves = reservations;
    const headers = { 'content-type': 'application/json' };
    if (origin !== undefined) headers.origin = origin;
    if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite;
    const response = await fetch(sameOrigin + '/api/session', {
      method: 'POST', headers,
      body: JSON.stringify({ url: sites[0].url }),
      redirect: 'error', signal: AbortSignal.timeout(4000)
    });
    const text = await response.text();
    return {
      status: response.status,
      started: starts - previousStarts,
      reserved: reservations - previousReserves,
      returnedBearer: /"token"\s*:|"viewerUrl"\s*:/.test(text)
    };
  }

  const allowed = await post({ origin: sameOrigin, fetchSite: 'same-origin' });
  assert.deepEqual({status: allowed.status, started: allowed.started, reserved: allowed.reserved},
    {status: 201, started: 1, reserved: 1}, 'same-origin JSON must remain usable');

  // The intended TV browser must retain both new and reused session flows
  // when origin enforcement is repaired. A reject-all rule would make the
  // strict negative CSRF checks green while breaking the actual product.
  const publicCreated = await post({ origin: publicTvOrigin, fetchSite: 'same-origin' });
  assert.deepEqual({ status: publicCreated.status, started: publicCreated.started,
    reserved: publicCreated.reserved, bearer: publicCreated.returnedBearer },
    { status: 201, started: 1, reserved: 1, bearer: true },
    'reviewed TV frontend Origin must still create an approved browser');
  const publicReused = await post({
    origin: publicTvOrigin, fetchSite: 'same-origin', preserve: true
  });
  assert.deepEqual({ status: publicReused.status, started: publicReused.started,
    reserved: publicReused.reserved, bearer: publicReused.returnedBearer },
    { status: 200, started: 0, reserved: 0, bearer: true },
    'reviewed TV frontend Origin must reuse its existing session');

  // Browser JavaScript normally cannot send application/json from a foreign
  // Origin without a successful OPTIONS preflight. Validate that current
  // mitigation separately from raw server-side POST admission behavior.
  const startsBeforePreflight = starts;
  const reservationsBeforePreflight = reservations;
  const preflightResults = [];
  for (const untrustedOrigin of ['https://attacker.invalid', 'null']) {
    const response = await fetch(sameOrigin + '/api/session', {
      method: 'OPTIONS',
      headers: {
        origin: untrustedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type'
      }, signal: AbortSignal.timeout(4000)
    });
    await response.arrayBuffer();
    const allowOrigin = response.headers.get('access-control-allow-origin');
    const denied = allowOrigin !== '*' && allowOrigin !== untrustedOrigin;
    preflightResults.push(denied);
    assert.equal(denied, true,
      'foreign browser JSON preflight must not authorize a cross-site Origin');
  }
  assert.equal(starts, startsBeforePreflight,
    'OPTIONS preflight must not launch any browser');
  assert.equal(reservations, reservationsBeforePreflight,
    'OPTIONS preflight must not consume a session reservation');

  // The fast-path reuse check precedes validStartUrl(). A remote Origin must
  // not receive a token-bearing 200 even when it causes no new allocation.
  const crossSiteReuse = await post({
    origin: 'https://attacker.invalid', fetchSite: 'cross-site', preserve: true
  });
  const crossSiteNew = await post({
    origin: 'https://attacker.invalid', fetchSite: 'cross-site'
  });
  const sandboxed = await post({ origin: 'null', fetchSite: 'cross-site' });
  const metadataOnly = await post({ fetchSite: 'cross-site' });

  // Non-browser clients without browser metadata may legitimately be supported;
  // do not assert a product policy for these existing gateway consumers.
  const nonBrowser = await post({});
  assert.equal(nonBrowser.status, 201, 'legacy non-browser JSON control must remain admitted');
  assert.equal(nonBrowser.started, 1);
  assert.equal(reservations, releases, 'all synthetic admissions must release capacity');

  const unsafe = { crossSiteReuse, crossSiteNew, sandboxed, metadataOnly };
  function denied(outcome) {
    return outcome.status >= 400 && outcome.started === 0 &&
      outcome.reserved === 0 && !outcome.returnedBearer;
  }
  if (strict) {
    assert.deepEqual(Object.fromEntries(
      Object.entries(unsafe).map(([name, outcome]) => [name, denied(outcome)])),
      {crossSiteReuse: true, crossSiteNew: true, sandboxed: true, metadataOnly: true},
      'strict admission must reject external and null Origin/Fetch Metadata before reuse/allocation');
    console.log('Real HTTP origin isolation and existing-session reuse PASS');
  } else {
    console.log('Browser JSON preflight denied=' +
      preflightResults.filter(Boolean).length + '/' + preflightResults.length +
      '; raw shipped JSON cross-site HTTP isolation: ' + JSON.stringify(
      Object.fromEntries(Object.entries(unsafe).map(([name, outcome]) =>
        [name, {status: outcome.status, started: outcome.started,
          rejectedBeforeBearer: denied(outcome)}]))
    ) + '; strict origin proof requires --require-origin-isolation');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
