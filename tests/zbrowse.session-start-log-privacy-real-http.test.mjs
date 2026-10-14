// Real 127.0.0.1 HTTP acceptance for shipped session-start error logging.
// Docker startup is a deterministic failing test double: no actual Docker,
// credential, VPS or public gateway. Only aggregate log findings are emitted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { format } from 'node:util';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-redacted-start-errors');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(sites.length > 0, 'reviewed URL configuration must be available');
function segment(begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, 'shipped gateway admission path must be extractable');
  return source.slice(start, stop);
}
const parser = source.match(/app\.use\(express\.json\(\{ limit: "8kb" \}\)\);/)?.[0];
assert.ok(parser, 'fixture must use actual gateway JSON parser');
const handler = [
  parser,
  segment('const allowedOrigins = new Set(', 'const trustProxyHops'),
  segment('function publicSession(', 'function validStartUrl('),
  segment('function validStartUrl(', 'async function waitForBrowser('),
  segment('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"')
].join('\n');
assert.ok(handler.includes('console.error("Session creation failed", error)'),
  'QA must exercise the shipped failure logger, not a test-only copy');

const app = express();
const ip = '127.0.0.1';
const token = 'M'.repeat(32); // fake and never issued to an external client
const password = 'synthetic-docker-secret-only';
const sessions = new Map();
const sessionsByIp = new Map();
const logs = [];
let createCalls = 0;
let reservations = 0;
let releases = 0;
const sandbox = {
  app, express, sites, URL, Date, Math,
  sessions, sessionsByIp, requestIp, trustProxyHops: 0,
  config: { ttlMs: 900_000, idleMs: 600_000, startUrl: sites[0].url },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected session destroy'); },
  sessionAdmission: {
    tryReserve() { reservations++; return { ok: true }; },
    release() { releases++; }
  },
  async createSession(owner, approvedUrl) {
    createCalls++;
    assert.equal(owner, ip);
    assert.equal(approvedUrl, sites[0].url);
    if (createCalls === 1) {
      // Models a Docker/API exception string containing request-scoped config.
      // This establishes conditional source logging behaviour, NOT evidence
      // a deployed Docker daemon generated this message.
      throw new Error('synthetic container setup failed Env PASSWORD=' +
        password + ' zbrowse.token=' + token);
    }
    const fixture = {
      token, ip, expiresAt: Date.now() + 900_000, lastSeenAt: Date.now()
    };
    sessions.set(token, fixture);
    sessionsByIp.set(ip, token);
    return fixture;
  },
  console: { error(...args) { logs.push(format(...args)); } }
};
vm.runInNewContext(handler, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const url = 'http://' + ip + ':' + server.address().port + '/api/session';
  async function submit(target) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target }), redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });
    return { status: response.status, text: await response.text() };
  }

  const unapproved = await submit('https://attacker.invalid/');
  assert.equal(unapproved.status, 400, 'unreviewed browser origins must never reach Docker');
  assert.equal(createCalls, 0);
  assert.equal(reservations, 0);

  const failed = await submit(sites[0].url);
  assert.equal(failed.status, 500, 'real HTTP route must return controlled creation failure');
  assert.equal(JSON.parse(failed.text).error, 'The browser could not be started.',
    'failure must remain a generic client-facing error');
  assert.doesNotMatch(failed.text, /synthetic-docker-secret|M{32}|PASSWORD/i,
    'HTTP error must never reflect upstream exception metadata');
  assert.equal(createCalls, 1);
  assert.equal(reservations, 1);
  assert.equal(releases, 1, 'failure must release reserved browser capacity');
  assert.equal(sessions.size, 0, 'failure must never publish synthetic session');

  const recovered = await submit(sites[0].url);
  assert.equal(recovered.status, 201, 'valid browser creation must recover after failed attempt');
  const payload = JSON.parse(recovered.text);
  assert.equal(payload.token, token, 'successful bearer delivery must remain functional');
  assert.equal(payload.viewerUrl, '/s/' + token + '/');
  const reused = await submit(sites[0].url);
  assert.equal(reused.status, 200, 'existing session must be reused after recovery');
  assert.equal(JSON.parse(reused.text).token, token);
  assert.equal(createCalls, 2, 'reused HTTP session must not start another browser');
  assert.equal(reservations, releases, 'every attempted browser start must release capacity');

  assert.equal(logs.length, 1, 'one upstream Docker exception must be logged');
  assert.ok(logs[0].includes('Session creation failed'),
    'safe generic diagnostic label must be preserved');
  const leaking = logs.filter(line => line.includes(token) || line.includes(password));
  if (strict) {
    assert.equal(leaking.length, 0,
      'startup failure logger must not print Docker error payload containing session bearer/credentials');
  }
  console.log('Shipped real HTTP browser-start failure diagnostics: ' +
    logs.length + ' synthetic Docker error, privacy-safe logs=' +
    (logs.length - leaking.length) + '/' + logs.length +
    '; strict proof: --require-redacted-start-errors');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
