// Source-tethered localhost HTTP admission tests for the gateway's JSON
// parser boundary. Oversized/malformed bodies must fail before Docker startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';

const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(sites.length > 0, 'reviewed sites needed for real HTTP fixture');
function section(begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, 'shipped gateway admission code must be extractable');
  return source.slice(start, stop);
}
const parser = source.match(/app\.use\(express\.json\(\{ limit: "8kb" \}\)\);/)?.[0];
assert.ok(parser, 'real gateway must retain a reviewed bounded JSON body parser');
const code = [
  parser,
  section('const allowedOrigins = new Set(', 'const trustProxyHops'),
  section('function publicSession(', 'function validStartUrl('),
  section('function validStartUrl(', 'async function waitForBrowser('),
  section('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"')
].join('\n');
const app = express();
const ip = '127.0.0.1';
const sessions = new Map();
const sessionsByIp = new Map();
let started = 0;
let reservations = 0;
let releases = 0;
const sandbox = {
  app, express, sites, URL, Math, Date, requestIp, trustProxyHops: 0,
  sessions, sessionsByIp,
  config: { startUrl: sites[0].url, ttlMs: 900_000, idleMs: 600_000 },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected teardown'); },
  validStartUrl: undefined,
  sessionAdmission: {
    tryReserve() { reservations++; return { ok: true }; },
    release() { releases++; }
  },
  async createSession(givenIp, target) {
    assert.equal(givenIp, ip);
    assert.equal(target, sites[0].url);
    started++;
    const session = {
      ip, token: 'J'.repeat(32),
      expiresAt: Date.now() + 900_000, lastSeenAt: Date.now()
    };
    sessions.set(session.token, session);
    sessionsByIp.set(ip, session.token);
    return session;
  },
  console: { error() { throw new Error('unexpected gateway creation failure'); } }
};
vm.runInNewContext(code, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
// Keep the fixture response deterministic without weakening parser status codes.
app.use((error, _req, res, _next) =>
  res.status(error.status || 500).json({ error: 'Invalid request payload' }));
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const endpoint = 'http://' + ip + ':' + server.address().port + '/api/session';
  async function submit(body, headers = { 'content-type': 'application/json' }) {
    sessions.clear();
    sessionsByIp.clear();
    const prior = started;
    const reserves = reservations;
    const reply = await fetch(endpoint, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(4000)
    });
    const bodyText = await reply.text();
    return {
      status: reply.status,
      newStarts: started - prior,
      newReservations: reservations - reserves,
      bodyText
    };
  }
  const accepted = await submit(JSON.stringify({ url: sites[0].url }));
  assert.equal(accepted.status, 201, 'reviewed JSON start request must create one browser');
  assert.equal(accepted.newStarts, 1);
  assert.equal(accepted.newReservations, 1);

  const invalidOrigin = await submit(JSON.stringify({ url: 'https://evil.invalid/' }));
  assert.equal(invalidOrigin.status, 400, 'unreviewed origin must fail admission');
  assert.equal(invalidOrigin.newStarts, 0);

  const truncated = await submit('{"url":');
  assert.equal(truncated.status, 400, 'malformed JSON must fail at body parsing boundary');
  assert.equal(truncated.newStarts, 0, 'malformed JSON must not launch browser');
  assert.equal(truncated.newReservations, 0);

  const tooLarge = await submit(JSON.stringify({
    url: sites[0].url, padding: 'x'.repeat(16 * 1024)
  }));
  assert.equal(tooLarge.status, 413, 'actual 8kb parser must reject oversized JSON');
  assert.equal(tooLarge.newStarts, 0, 'oversized request must not start a container');
  assert.equal(tooLarge.newReservations, 0, 'oversized request must not reserve capacity');

  const badCharset = await submit(JSON.stringify({ url: sites[0].url }),
    { 'content-type': 'application/json; charset=iso-8859-1' });
  assert.equal(badCharset.status, 415, 'unsupported JSON charset must be rejected');
  assert.equal(badCharset.newStarts, 0);
  assert.equal(badCharset.newReservations, 0);

  const recovered = await submit(JSON.stringify({ url: sites[0].url }));
  assert.equal(recovered.status, 201, 'valid browser start must recover after malicious body traffic');
  assert.equal(recovered.newStarts, 1);
  assert.equal(reservations, releases, 'every admitted start must release admission reservation');

  for (const rejected of [truncated, tooLarge, badCharset]) {
    assert.doesNotMatch(rejected.bodyText, /J{32}|viewerUrl|\/s\/J/,
      'parser errors must not disclose synthetic session bearer metadata');
  }
  console.log('Shipped gateway JSON parsing/size/charset HTTP admission boundary passed');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
