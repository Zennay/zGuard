// Security regression: browser-simple cross-origin POST bodies must not
// allocate a remote browser when the gateway ignores their Content-Type.
// The shipped parser, allowed-origin guard and POST route are run over real
// 127.0.0.1 HTTP, with synthetic Docker-free session creation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-json-only');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
assert.ok(sites.length > 0, 'reviewed start site required');
function section(begin, end) {
  const a = source.indexOf(begin);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'shipped gateway HTTP admission source must be extractable');
  return source.slice(a, b);
}
const parser = source.match(/app\.use\(express\.json\(\{ limit: "8kb" \}\)\);/)?.[0];
assert.ok(parser, 'reviewed gateway JSON parser must remain source-bound');
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
let created = 0;
let reserved = 0;
let released = 0;
const sandbox = {
  app, express, sites, URL, Date, Math,
  sessions, sessionsByIp, requestIp, trustProxyHops: 0,
  config: { startUrl: sites[0].url, ttlMs: 900_000, idleMs: 600_000 },
  sessionLimiter(_req, _res, next) { next(); },
  isSessionExpired() { return false; },
  destroySession() { throw new Error('unexpected teardown'); },
  sessionAdmission: {
    tryReserve() { reserved++; return { ok: true }; },
    release() { released++; }
  },
  async createSession(owner, url) {
    assert.equal(owner, ip);
    assert.equal(url, sites[0].url, 'fixture may launch only reviewed origin');
    created++;
    const session = {
      ip, token: 'Q'.repeat(32), lastSeenAt: Date.now(),
      expiresAt: Date.now() + 900_000
    };
    sessions.set(session.token, session);
    sessionsByIp.set(ip, session.token);
    return session;
  },
  console: { error() { throw new Error('unexpected createSession error'); } }
};
vm.runInNewContext(code, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, ip, () => resolve(listening));
  listening.once('error', reject);
});
try {
  async function submit(contentType, body, origin, preserveSession = false) {
    if (!preserveSession) {
      sessions.clear();
      sessionsByIp.clear();
    }
    const oldCreated = created;
    const oldReserved = reserved;
    // Omitting the media type altogether matters: a browser can dispatch a
    // bodyless cross-site POST without preflight and without JSON parsing.
    const headers = contentType ? { 'content-type': contentType } : {};
    if (origin) {
      headers.origin = origin;
      headers['sec-fetch-site'] = 'cross-site';
    }
    const response = await fetch('http://' + ip + ':' +
      server.address().port + '/api/session', {
      method: 'POST', headers, body, signal: AbortSignal.timeout(4000)
    });
    const responseBody = await response.text();
    return {
      status: response.status,
      newContainers: created - oldCreated,
      newReservations: reserved - oldReserved,
      responseBody
    };
  }
  const accepted = await submit('application/json',
    JSON.stringify({ url: sites[0].url }));
  assert.deepEqual({
    status: accepted.status, launched: accepted.newContainers
  }, { status: 201, launched: 1 }, 'approved JSON request must still launch one browser');

  // All three browser form encodings (text/plain, urlencoded, multipart)
  // can be sent across origins without CORS preflight. Denying response access
  // alone does not prevent the server-side session side effect. A malicious
  // form may also send a charset parameter or a sandboxed Origin: null.
  const simpleMedia = [
    [null, undefined, 'https://attacker.invalid'],
    ['text/plain', 'launch=anything', 'https://attacker.invalid'],
    ['text/plain; charset=UTF-8', 'ignored=true', 'https://attacker.invalid'],
    ['application/x-www-form-urlencoded', 'url=https%3A%2F%2Fattacker.invalid%2F', 'https://attacker.invalid'],
    ['multipart/form-data; boundary=zguard-form',
      '--zguard-form\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://attacker.invalid/\r\n--zguard-form--\r\n',
      'https://attacker.invalid'],
    ['text/plain', 'launch=anything', 'null']
  ];
  const acceptedSimple = [];
  // A pre-existing valid browser can be much more valuable to a cross-site
  // caller than a fresh allocation. Exercise *every* simple Content-Type
  // before the fast-path 200 token return, not just urlencoded submissions.
  const ownerBeforeReuse = sessionsByIp.get(ip);
  const reusedUnprotected = [];
  for (const [mediaType, body, origin] of simpleMedia) {
    const reused = await submit(mediaType, body, origin, true);
    if (reused.status < 400 || reused.newContainers !== 0 ||
        reused.newReservations !== 0 ||
        /"token"\s*:|"viewerUrl"\s*:/.test(reused.responseBody)) {
      reusedUnprotected.push(mediaType ?? '(no Content-Type; empty body)');
    }
    assert.equal(sessionsByIp.get(ip), ownerBeforeReuse,
      'cross-site replay must not replace existing browser ownership');
    assert.equal(sessions.size, 1,
      'cross-site replay must never cause a second running container');
  }

  for (const [mediaType, body, origin] of simpleMedia) {
    const result = await submit(mediaType, body, origin);
    if (result.newContainers !== 0 || result.newReservations !== 0 ||
        result.status < 400) {
      acceptedSimple.push((mediaType ?? '(no Content-Type; empty body)') + ':HTTP_' + result.status);
    }
  }
  assert.equal(reserved, released,
    'all admissions, including unsafe request types, must release reservations');
  if (strict) {
    assert.deepEqual(reusedUnprotected, [],
      'all six cross-origin form variants must fail before token-bearing reuse');
    assert.deepEqual(acceptedSimple, [],
      'cross-site POSTs without JSON media type, including bodyless requests, must never allocate a browser (CSRF admission risk)');
    console.log('Session admission rejects browser-simple cross-origin non-JSON POST bodies');
  } else {
    console.log('Actual gateway simple cross-origin POST source-bound probe: ' +
      'unexpectedly admitted media types=' + acceptedSimple.join(', ') +
      '; existing-session form reuse unprotected=' + reusedUnprotected.length +
      '/' + simpleMedia.length +
      '. Strict remediation proof: --require-json-only');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
