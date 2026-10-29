// Run the shipped start-URL guard and /api/session route through actual
// loopback Express HTTP. No Docker, browser process, public target or network
// outside 127.0.0.1. Userinfo fixtures contain no real credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-credential-free');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(Array.isArray(sites) && sites.length > 0, 'reviewed site catalogue required');

function section(begin, endMarker) {
  const start = source.indexOf(begin);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'production URL guard/route must be extractable');
  return source.slice(start, end);
}
const code = [
  section('const allowedOrigins = new Set(', 'const trustProxyHops'),
  section('function publicSession(', 'function validStartUrl('),
  section('function validStartUrl(', 'async function waitForBrowser('),
  section('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"')
].join('\n');
const app = express();
app.use(express.json({ limit: '8kb' }));
const ip = '127.0.0.1';
const sessions = new Map();
const sessionsByIp = new Map();
let starts = 0;
let releases = 0;
const sandbox = {
  app, sites, sessions, sessionsByIp, URL, Math, Date,
  requestIp, trustProxyHops: 0,
  config: { startUrl: sites[0].url, ttlMs: 900_000, idleMs: 600_000 },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected fixture session teardown'); },
  sessionAdmission: {
    tryReserve() { return { ok: true }; },
    release() { releases++; }
  },
  async createSession(givenIp, url) {
    assert.equal(givenIp, ip);
    assert.equal(new URL(url).origin, new URL(sites[0].url).origin,
      'only a reviewed origin may reach the synthetic browser startup');
    starts++;
    const fixture = {
      token: 'A'.repeat(32), ip, expiresAt: Date.now() + 900_000,
      lastSeenAt: Date.now()
    };
    sessions.set(fixture.token, fixture);
    sessionsByIp.set(ip, fixture.token);
    return fixture;
  },
  console: { error() { throw new Error('unexpected session creation failure'); } }
};
vm.runInNewContext(code, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  async function postStartUrl(url, preserveExisting = false) {
    if (!preserveExisting) {
      sessions.clear();
      sessionsByIp.clear();
    }
    const before = starts;
    const reply = await fetch('http://' + ip + ':' + server.address().port +
      '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(4000)
    });
    const body = await reply.text();
    // A denial that still includes a session bearer is not a denial:
    // both first admission and existing-owner reuse must stay secret-free.
    const hasBearer = /"token"\s*:|"viewerUrl"\s*:/.test(body);
    return { status: reply.status, newStarts: starts - before, hasBearer };
  }
  const approved = await postStartUrl(sites[0].url);
  assert.deepEqual(approved, { status: 201, newStarts: 1, hasBearer: true },
    'actual HTTP route must still admit a reviewed start URL');
  const authority = new URL(sites[0].url).host;
  // Source-bound regression for the existing-session fast path. An accepted
  // request for an existing client must not bypass userinfo validation and
  // return its bearer-bearing HTTP 200 for a credential-bearing start URL.
  const reusedCredential = await postStartUrl('https://user:pass@' + authority + '/watch', true);
  const reusedDenied = reusedCredential.status === 400 &&
    reusedCredential.newStarts === 0 && !reusedCredential.hasBearer;
  const lookalike = await postStartUrl('https://' + authority + '.attacker.invalid/watch');
  assert.deepEqual(lookalike, { status: 400, newStarts: 0, hasBearer: false },
    'actual HTTP route must reject an unreviewed lookalike origin');

  const credentialCases = [
    ['user-pass', 'https://user:pass@' + authority + '/watch'],
    ['user-only', 'https://user@' + authority + '/watch'],
    ['password-only', 'https://:pass@' + authority + '/watch'],
    ['encoded-user', 'https://us%65r@' + authority + '/watch'],
    ['encoded-password', 'https://user:%70ass@' + authority + '/watch'],
    ['encoded-at-in-user', 'https://user%40attacker.invalid@' + authority + '/watch'],
    ['multiple-at', 'https://user@attacker.invalid@' + authority + '/watch'],
    ['encoded-colon-user', 'https://u%3Aser:pass@' + authority + '/watch'],
    ['encoded-slash-password', 'https://user:pa%2Fss@' + authority + '/watch'],
    ['encoded-null-user', 'https://%00user:pass@' + authority + '/watch'],
    ['unicode-username', 'https://%F0%9F%98%80@' + authority + '/watch'],
    ['encoded-double-at-password', 'https://user:pa%40ss@' + authority + '/watch'],
    ['double-encoded-user', 'https://%257573er@' + authority + '/watch'],
    ['encoded-backslash-user', 'https://u%5Cser:pass@' + authority + '/watch']
  ];
  const failures = [];
  for (const [label, candidate] of credentialCases) {
    const outcome = await postStartUrl(candidate);
    if (outcome.status !== 400 || outcome.newStarts !== 0 ||
        outcome.hasBearer) failures.push(label);
  }
  // Each userinfo encoding must also be rejected when a valid session
  // already exists for the same peer. The current fast path runs before
  // URL validation; otherwise one bad URL can recover a live bearer 200.
  const active = await postStartUrl(sites[0].url);
  assert.deepEqual(active, { status: 201, newStarts: 1, hasBearer: true },
    'fixture must establish a single existing session for reuse checks');
  const ownerBefore = sessionsByIp.get(ip);
  const reusedFailures = [];
  for (const [label, candidate] of credentialCases) {
    const outcome = await postStartUrl(candidate, true);
    if (outcome.status !== 400 || outcome.newStarts !== 0 ||
        outcome.hasBearer) {
      reusedFailures.push(label);
    }
    assert.equal(sessionsByIp.get(ip), ownerBefore,
      'malformed reuse must never replace the current browser owner');
    assert.equal(sessions.size, 1, 'credential-bearing reuse must not allocate a second browser');
  }
  assert.equal(releases, starts, 'every synthetic browser admission must release reservation');
  if (strict) {
    assert.equal(reusedDenied, true,
      'existing-session credentialed URL must return 400 without any bearer or viewer URL (issue #266)');
    assert.deepEqual(reusedFailures, [],
      'existing-session fast path must reject every encoded userinfo form before returning a bearer');
    assert.deepEqual(failures, [],
      'real HTTP start URL guard accepts embedded userinfo (issue #266): ' + failures.join(', '));
    console.log('Real HTTP credential-free start URL acceptance PASS');
  } else {
    console.log('Shipped HTTP start URL guard validates reviewed origin/lookalikes; ' +
      'userinfo cases accepted=' + failures.length + '/' + credentialCases.length +
      ', existing-session credential reuse denied=' +
      (credentialCases.length - reusedFailures.length) + '/' + credentialCases.length +
      ' (strict gate requires --require-credential-free; issue #266 remains open)');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
