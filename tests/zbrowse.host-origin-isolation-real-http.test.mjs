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
  async function submit({ host, origin, fetchSite = 'same-origin', reuse = false,
    forwardedProto, forwardedHost }) {
    if (!reuse) {
      sessions.clear();
      sessionsByIp.clear();
    }
    const oldStarts = starts;
    const oldReserves = reserves;
    const payload = JSON.stringify({ url: sites[0].url });
    const headers = {
      'Host': host,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (origin !== undefined) headers.Origin = origin;
    if (fetchSite !== null) headers['Sec-Fetch-Site'] = fetchSite;
    if (forwardedProto) headers['X-Forwarded-Proto'] = forwardedProto;
    if (forwardedHost) headers['X-Forwarded-Host'] = forwardedHost;
    // Preserve duplicate Host, Origin and Sec-Fetch-Site lines as actual
    // wire headers. A JSON object mock can miss Node/proxy coalescing and
    // misclassify conflicting browser metadata as one reviewed value.
    const repeated = Array.isArray(host) || Array.isArray(origin) ||
      Array.isArray(fetchSite);
    const wireHeaders = repeated
      ? [...(Array.isArray(host) ? host.flatMap(value => ['Host', value])
        : ['Host', host]),
        ...Object.entries(headers).filter(([name]) => name !== 'Host')
          .flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value])
              .flatMap(item => [name, item]))]
      : headers;
    const reply = await new Promise((resolve, reject) => {
      const request = http.request({
        host: peer, port, method: 'POST', path: '/api/session',
        headers: wireHeaders
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

  // Null, opaque and deliberately malformed Origin / Fetch Metadata must
  // never mint a new bearer or reuse a prior valid owner's bearer. Test real
  // HTTP responses rather than only checking the origin matcher in isolation.
  const untrustedBrowserMetadata = [
    ['opaque Origin', 'null', 'same-origin'],
    ['trailing slash Origin', publicTv + '/', 'same-origin'],
    ['whitespace-padded Origin', ' ' + publicTv, 'same-origin'],
    ['uppercase foreign Origin', 'HTTPS://ATTACKER.INVALID', 'same-origin'],
    ['cross-site metadata', publicTv, 'cross-site'],
    ['mixed-case cross-site metadata', publicTv, 'Cross-Site'],
    ['unknown metadata token', publicTv, 'same-origin,cross-site'],
    ['empty metadata token', publicTv, '']
  ];
  const badMetadataStarts = [];
  const badMetadataReuses = [];
  for (const [label, origin, fetchSite] of untrustedBrowserMetadata) {
    const initial = await submit({ host: legitimateHost, origin, fetchSite });
    const existing = await submit({ host: legitimateHost, origin,
      fetchSite, reuse: true });
    badMetadataStarts.push([label, initial]);
    badMetadataReuses.push([label, existing]);
  }
  assert.ok(badMetadataStarts.every(([, outcome]) => denied(outcome)) &&
    badMetadataReuses.every(([, outcome]) => denied(outcome)),
    'untrusted browser Origin / Fetch Metadata cannot create or reuse bearer sessions');

  // Distinguish a foreign Origin from a foreign Host that makes the request
  // appear locally same-origin. Both raw HTTP header values are client input;
  // proxy Host allowlisting must be verified separately in deployment.
  const changedHost = await submit({ host: forgedHost, origin: forgedOrigin });
  const reusedHost = await submit({ host: forgedHost, origin: forgedOrigin,
    reuse: true });
  // A reviewed browser Origin must not authorize requests delivered through
  // an unreviewed Host either. This tests both allocation and token reuse
  // instead of only matching a forged Host to a forged Origin.
  const tvViaForeignHost = await submit({ host: forgedHost, origin: publicTv });
  const tvReusedViaForeignHost = await submit({ host: forgedHost, origin: publicTv,
    reuse: true });
  // Non-browser clients may omit both Origin and Fetch Metadata. They must
  // keep working under a canonical Host, but must not make ANY arbitrary Host
  // an authorized session issuer or session-reuse endpoint.
  const metadataFreeHost = await submit({ host: forgedHost,
    origin: undefined, fetchSite: null });
  const metadataFreeReuse = await submit({ host: forgedHost,
    origin: undefined, fetchSite: null, reuse: true });
  // Ambiguous Host headers can be processed differently by intermediaries
  // and Node. Preserve both lines on real TCP and reject them regardless of
  // their order or whether their string values happen to match.
  const duplicateHostOutcomes = [];
  const duplicateHostReuses = [];
  for (const hostValues of [
    [legitimateHost, forgedHost],
    [forgedHost, legitimateHost],
    [legitimateHost, legitimateHost]
  ]) {
    duplicateHostOutcomes.push(await submit({ host: hostValues, origin: publicTv }));
    duplicateHostReuses.push(await submit({ host: hostValues, origin: publicTv,
      reuse: true }));
  }
  // Duplicate browser metadata is ambiguous even with a canonical Host.
  // Check both orderings AND token reuse over genuine HTTP, not VM requests.
  const conflictingOrigins = [];
  const conflictingOriginReuses = [];
  for (const values of [
    [publicTv, forgedOrigin], [forgedOrigin, publicTv], [publicTv, publicTv]
  ]) {
    conflictingOrigins.push(await submit({
      host: legitimateHost, origin: values
    }));
    conflictingOriginReuses.push(await submit({
      host: legitimateHost, origin: values, reuse: true
    }));
  }
  assert.ok(conflictingOrigins.every(denied) &&
    conflictingOriginReuses.every(denied),
    'ambiguous repeated Origin must deny new and reused sessions');
  const conflictingFetchSites = [];
  const conflictingFetchSiteReuses = [];
  for (const values of [
    ['same-origin', 'cross-site'], ['cross-site', 'same-origin'],
    ['same-origin', 'same-origin']
  ]) {
    conflictingFetchSites.push(await submit({
      host: legitimateHost, origin: publicTv, fetchSite: values
    }));
    conflictingFetchSiteReuses.push(await submit({
      host: legitimateHost, origin: publicTv, fetchSite: values, reuse: true
    }));
  }
  assert.ok(conflictingFetchSites.every(denied) &&
    conflictingFetchSiteReuses.every(denied),
    'ambiguous repeated Fetch Metadata must deny new and reused sessions');
  const wrongPortHost = peer + ':' + (port === 65535 ? 1 : port + 1);
  const alternatePort = await submit({ host: wrongPortHost, origin: publicTv });
  const alternatePortReuse = await submit({ host: wrongPortHost,
    origin: publicTv, reuse: true });
  const emptyHost = await submit({ host: '', origin: publicTv });
  const emptyHostReuse = await submit({ host: '', origin: publicTv, reuse: true });
  const canonicalNonBrowser = await submit({ host: legitimateHost,
    origin: undefined, fetchSite: null });
  assert.ok(admitted(canonicalNonBrowser, 201),
    'metadata-free JSON API clients must work with a reviewed Host');
  const stillAllowed = await submit({ host: legitimateHost, origin: publicTv });
  assert.ok(admitted(stillAllowed, 201),
    'browser admission must recover after the adversarial Host probe');

  // When an operator explicitly configures a trusted reverse-proxy hop,
  // Express derives req.protocol from X-Forwarded-Proto. Exercise that
  // reviewed alternate scheme independently: spoofing BOTH Host and the
  // forwarded scheme cannot create trusted authority from client headers.
  // This simulates the application-side proxy setting, not a real ingress.
  app.set('trust proxy', 1);
  const proxyForeign = await submit({ host: forgedHost,
    origin: 'https://' + forgedHost, forwardedProto: 'https' });
  const proxyForeignReuse = await submit({ host: forgedHost,
    origin: 'https://' + forgedHost, forwardedProto: 'https', reuse: true });
  const proxyTvForeign = await submit({ host: forgedHost,
    origin: publicTv, forwardedProto: 'https' });
  const proxyTvForeignReuse = await submit({ host: forgedHost,
    origin: publicTv, forwardedProto: 'https', reuse: true });
  const proxyMetadataFree = await submit({ host: forgedHost,
    origin: undefined, fetchSite: null, forwardedProto: 'https' });
  const proxyMetadataFreeReuse = await submit({ host: forgedHost,
    origin: undefined, fetchSite: null, forwardedProto: 'https', reuse: true });
  // A reverse proxy may forward its own canonical authority separately
  // from the client-controlled HTTP Host. X-Forwarded-Host must never
  // retroactively bless an unreviewed Host or expose the existing bearer.
  const forwardedHostForeign = await submit({ host: forgedHost,
    origin: publicTv, forwardedProto: 'https', forwardedHost: legitimateHost });
  const forwardedHostForeignReuse = await submit({ host: forgedHost,
    origin: publicTv, forwardedProto: 'https', forwardedHost: legitimateHost,
    reuse: true });
  const forwardedHostSpoofedOrigin = await submit({ host: forgedHost,
    origin: 'https://' + forgedHost, forwardedProto: 'https',
    forwardedHost: legitimateHost });
  const forwardedHostSpoofedReuse = await submit({ host: forgedHost,
    origin: 'https://' + forgedHost, forwardedProto: 'https',
    forwardedHost: legitimateHost, reuse: true });
  const proxyApproved = await submit({ host: legitimateHost,
    origin: 'https://' + legitimateHost, forwardedProto: 'https' });
  assert.ok(admitted(proxyApproved, 201),
    'legitimate HTTPS origin behind configured proxy must remain usable');
  const proxyMismatch = await submit({ host: legitimateHost,
    origin: 'https://' + forgedHost, forwardedProto: 'https' });
  assert.ok(denied(proxyMismatch),
    'canonical HTTPS Host must not accept unrelated forwarded Origin');
  assert.equal(reserves, releases, 'all reserved slots must release');

  if (strict) {
    assert.ok(denied(changedHost),
      'unreviewed Host and matching forged Origin must not create a browser');
    assert.ok(denied(reusedHost),
      'unreviewed Host and matching forged Origin must not return a bearer');
    assert.ok(denied(tvViaForeignHost),
      'reviewed TV Origin cannot authorize a browser through an unreviewed Host');
    assert.ok(denied(tvReusedViaForeignHost),
      'reviewed TV Origin cannot reuse a bearer through an unreviewed Host');
    assert.ok(denied(metadataFreeHost) && denied(metadataFreeReuse),
      'metadata-free clients cannot start or reuse browsers through unreviewed Host');
    assert.ok(duplicateHostOutcomes.every(denied) && duplicateHostReuses.every(denied),
      'duplicate Host must deny both browser creation and existing bearer reuse');
    assert.ok([alternatePort, alternatePortReuse, emptyHost, emptyHostReuse].every(denied),
      'alternate-port or empty Host cannot mint or reuse session credentials');
    for (const [name, outcome] of [
      ['proxy same-origin start', proxyForeign],
      ['proxy same-origin reuse', proxyForeignReuse],
      ['proxy reviewed TV start', proxyTvForeign],
      ['proxy reviewed TV reuse', proxyTvForeignReuse],
      ['proxy metadata-free start', proxyMetadataFree],
      ['proxy metadata-free reuse', proxyMetadataFreeReuse],
      ['forwarded canonical Host + reviewed TV start', forwardedHostForeign],
      ['forwarded canonical Host + reviewed TV reuse', forwardedHostForeignReuse],
      ['forwarded canonical Host + spoofed Origin start', forwardedHostSpoofedOrigin],
      ['forwarded canonical Host + spoofed Origin reuse', forwardedHostSpoofedReuse]
    ]) {
      assert.ok(denied(outcome),
        'unreviewed Host must fail under configured HTTPS proxy: ' + name);
    }
    console.log('Shipped gateway trusted-host origin isolation PASS');
  } else {
    console.log('Actual localhost Host/Origin admission: foreign Host new denied=' +
      denied(changedHost) + '; foreign Host reuse denied=' + denied(reusedHost) +
      '; foreign Host with reviewed TV Origin new denied=' + denied(tvViaForeignHost) +
      '; foreign Host with reviewed TV Origin reuse denied=' + denied(tvReusedViaForeignHost) +
      '; metadata-free foreign Host denied=' + denied(metadataFreeHost) +
      '; metadata-free foreign Host reuse denied=' + denied(metadataFreeReuse) +
      '; duplicate Host new denied=' + duplicateHostOutcomes.filter(denied).length +
      '/' + duplicateHostOutcomes.length +
      '; duplicate Host reuse denied=' + duplicateHostReuses.filter(denied).length +
      '/' + duplicateHostReuses.length +
      '; alternate-port Host denied=' + denied(alternatePort) +
      '; alternate-port reuse denied=' + denied(alternatePortReuse) +
      '; empty Host denied=' + denied(emptyHost) +
      '; empty Host reuse denied=' + denied(emptyHostReuse) +
      '; canonical-Host negative control denied=' + denied(mismatch) +
      '; proxy-HTTPS foreign Host denied=' + denied(proxyForeign) +
      '; proxy-HTTPS foreign Host reuse denied=' + denied(proxyForeignReuse) +
      '; proxy-HTTPS reviewed TV denied=' + denied(proxyTvForeign) +
      '; proxy-HTTPS reviewed TV reuse denied=' + denied(proxyTvForeignReuse) +
      '; proxy-HTTPS metadata-free Host denied=' + denied(proxyMetadataFree) +
      '; proxy-HTTPS metadata-free reuse denied=' + denied(proxyMetadataFreeReuse) +
      '; forwarded canonical Host with unreviewed wire Host TV start denied=' +
      denied(forwardedHostForeign) +
      '; forwarded canonical Host with unreviewed wire Host TV reuse denied=' +
      denied(forwardedHostForeignReuse) +
      '; forwarded canonical Host with spoofed Origin denied=' +
      denied(forwardedHostSpoofedOrigin) +
      '; forwarded canonical Host with spoofed Origin reuse denied=' +
      denied(forwardedHostSpoofedReuse) +
      '. No public reverse-proxy or deployed DNS exposure tested.');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
