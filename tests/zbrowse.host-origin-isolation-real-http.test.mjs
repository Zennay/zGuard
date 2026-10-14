// Real loopback HTTP regression for Host-derived "same-origin" browser starts.
// Uses the shipped Express session route and JSON parser; Docker is synthetic.
// This is a conditional reverse-proxy/Host-routing risk, not proof of public exposure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-canonical-host');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const helmet = require('helmet');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(sites.length > 0, 'at least one approved browser site is required');
function section(begin, end) {
  const first = source.indexOf(begin);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'shipped gateway source boundary must exist');
  return source.slice(first, last);
}
const app = express();
const sessions = new Map();
const sessionsByIp = new Map();
const peer = '127.0.0.1';
let starts = 0;
let reserves = 0;
let releases = 0;
const sandbox = {
  app, express, helmet, sites, URL, Date, Math,
  requestIp, trustProxyHops: 0, sessions, sessionsByIp,
  config: { startUrl: sites[0].url, ttlMs: 900_000, idleMs: 600_000 },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected teardown'); },
  sessionAdmission: {
    tryReserve() { reserves++; return { ok: true }; },
    release() { releases++; }
  },
  async createSession(ip, url) {
    assert.equal(ip, peer);
    assert.equal(url, sites[0].url);
    starts++;
    const session = {
      ip, token: 'H'.repeat(32), expiresAt: Date.now() + 900_000,
      lastSeenAt: Date.now()
    };
    sessions.set(session.token, session);
    sessionsByIp.set(ip, session.token);
    return session;
  },
  console: { error() { throw new Error('unexpected browser creation error'); } }
};
const code = [
  section('app.set("trust proxy", trustProxyHops);', 'const sessionLimiter = rateLimit('),
  section('const allowedOrigins = new Set(', 'const trustProxyHops'),
  section('function publicSession(', 'function validStartUrl('),
  section('function validStartUrl(', 'async function waitForBrowser('),
  section('app.post("/api/session",', 'app.post("/api/session/:token/heartbeat"')
].join('\n');
assert.ok(code.includes('app.use(express.json({ limit: "8kb" }));'),
  'exercise the shipped bounded JSON parser');
vm.runInNewContext(code, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, peer, () => resolve(listening));
  listening.once('error', reject);
});
try {
  const port = server.address().port;
  const legitimateHost = peer + ':' + port;
  const publicTv = 'https://zbrowse-tv.lizellay.chatgpt.site';
  const forgedHost = 'attacker.invalid';
  const forgedOrigin = 'http://' + forgedHost;
  async function submit({ host, origin, fetchSite = 'same-origin', reuse = false }) {
    if (!reuse) {
      sessions.clear();
      sessionsByIp.clear();
    }
    const oldStarts = starts;
    const oldReserves = reserves;
    const payload = JSON.stringify({ url: sites[0].url });
    const reply = await new Promise((resolve, reject) => {
      const request = http.request({
        host: peer, port, method: 'POST', path: '/api/session',
        headers: {
          'Host': host,
          'Origin': origin,
          'Sec-Fetch-Site': fetchSite,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        }));
        response.once('error', reject);
      });
      request.setTimeout(4000, () => request.destroy(new Error('localhost probe timed out')));
      request.once('error', reject);
      request.end(payload);
    });
    return {
      status: reply.status,
      starts: starts - oldStarts,
      reserves: reserves - oldReserves,
      bearer: /"token"\s*:|"viewerUrl"\s*:/.test(reply.body)
    };
  }
  function admitted(outcome, status) {
    return outcome.status === status && outcome.bearer &&
      outcome.starts === (status === 201 ? 1 : 0) &&
      outcome.reserves === (status === 201 ? 1 : 0);
  }
  function denied(outcome) {
    return outcome.status >= 400 && outcome.starts === 0 &&
      outcome.reserves === 0 && !outcome.bearer;
  }

  // Controls: existing TV and genuinely same-origin clients still work.
  const local = await submit({ host: legitimateHost,
    origin: 'http://' + legitimateHost });
  assert.ok(admitted(local, 201), 'actual same-origin JSON POST must keep working');
  const tv = await submit({ host: legitimateHost, origin: publicTv });
  assert.ok(admitted(tv, 201), 'explicitly reviewed TV Origin must keep working');
  const mismatch = await submit({ host: legitimateHost, origin: forgedOrigin });
  assert.ok(denied(mismatch), 'foreign Origin with the canonical Host must be denied');

  // Distinguish a foreign Origin from a foreign Host that makes the request
  // appear locally same-origin. Both raw HTTP header values are client input;
  // proxy Host allowlisting must be verified separately in deployment.
  const changedHost = await submit({ host: forgedHost, origin: forgedOrigin });
  const reusedHost = await submit({ host: forgedHost, origin: forgedOrigin,
    reuse: true });
  const stillAllowed = await submit({ host: legitimateHost, origin: publicTv });
  assert.ok(admitted(stillAllowed, 201),
    'browser admission must recover after the adversarial Host probe');
  assert.equal(reserves, releases, 'all reserved slots must release');

  if (strict) {
    assert.ok(denied(changedHost),
      'unreviewed Host and matching forged Origin must not create a browser');
    assert.ok(denied(reusedHost),
      'unreviewed Host and matching forged Origin must not return a bearer');
    console.log('Shipped gateway trusted-host origin isolation PASS');
  } else {
    console.log('Actual localhost Host/Origin admission: foreign Host new denied=' +
      denied(changedHost) + '; foreign Host reuse denied=' + denied(reusedHost) +
      '; canonical-Host negative control denied=' + denied(mismatch) +
      '. No public reverse-proxy or deployed DNS exposure tested.');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
