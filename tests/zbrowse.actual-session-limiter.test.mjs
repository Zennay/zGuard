// Source-tethered HTTP acceptance for gateway session throttling.
// Unlike the independent mock policy fixture, this uses the rateLimit()
// declaration extracted from the *shipped* gateway server.js. No Docker,
// public site, session token, or real gateway is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-source-parity');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');

const start = source.indexOf('const sessionLimiter = rateLimit(');
const end = source.indexOf('function publicSession(', start);
assert.ok(start >= 0 && end > start, 'production session limiter declaration must be extractable');
assert.ok(source.includes('app.post("/api/session", sessionLimiter,'),
  'production session route must actually register the reviewed limiter');
const limiterSource = source.slice(start, end);
const limitMatch = limiterSource.match(/\blimit:\s*(\d+)\s*[,}]/);
assert.ok(limitMatch, 'production limiter must keep a bounded literal request limit');
const limit = Number(limitMatch[1]);
assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 32,
  'test must fail closed if production limit exceeds bounded QA budget');

function productionLimiter() {
  return vm.runInNewContext(limiterSource + '\nsessionLimiter', { rateLimit },
    { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
}
async function scenario(makeForwarded, trustedHops = 2) {
  const app = express();
  app.set('trust proxy', trustedHops);
  app.post('/api/session', productionLimiter(), (req, res) => {
    res.json({
      sessionIdentity: requestIp(req, trustedHops),
      limiterIdentity: req.ip
    });
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  try {
    const out = [];
    for (let i = 0; i <= limit; i += 1) {
      const forwarded = makeForwarded(i);
      const reply = await fetch('http://127.0.0.1:' + server.address().port +
        '/api/session', {
        method: 'POST',
        headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
        signal: AbortSignal.timeout(4000)
      });
      out.push({
        status: reply.status,
        identity: reply.status === 200 ? await reply.json() : null
      });
      if (reply.status !== 200) await reply.arrayBuffer();
    }
    return out;
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

// The trusted two-hop proxy chain must place every request from the same
// reviewed client in the same bucket despite a different untrusted prefix.
const complete = await scenario(i => '192.0.2.' + (i + 10) +
  ', 198.51.100.20, 10.0.0.2');
assert.deepEqual(complete.map(x => x.status), [
  ...Array(limit).fill(200), 429
], 'actual production limiter must enforce its configured quota for complete trusted chain');
assert.equal(complete[0].identity.sessionIdentity, '198.51.100.20');
assert.equal(complete[0].identity.limiterIdentity, '198.51.100.20');

// Incomplete chains fall back to the TCP peer for session ownership. The
// native Express limiter must not let left-side forged client IPs mint quota.
const incomplete = await scenario(i => '203.0.113.' + (i + 10));
assert.equal(incomplete[0].status, 200, 'first incomplete chain request should be admitted');
assert.equal(incomplete[0].identity.sessionIdentity, '127.0.0.1',
  'gateway session ownership must fail closed to the socket on incomplete forwarding');

// A full-length chain with a syntactically invalid client hop must not mint
// independent quotas by changing only the malformed leftmost value. The
// gateway's requestIp() rejects that identity and falls back to the TCP peer.
const malformed = await scenario(i => 'invalid-client-' + i + ', 10.0.0.2');
assert.equal(malformed[0].status, 200,
  'first invalid client address request must reach the actual limiter');
assert.equal(malformed[0].identity.sessionIdentity, '127.0.0.1',
  'invalid XFF client address must not become the gateway session owner');

// Reverse proxies can append a source port in XFF. Those values are not
// canonical client IPs; changing only a port must never allocate fresh quota
// for the same TCP peer while session ownership falls back to that peer.
const portTagged = await scenario(i => '198.51.100.20:' + (4100 + i) + ', 10.0.0.2');
assert.equal(portTagged[0].status, 200);
assert.equal(portTagged[0].identity.sessionIdentity, '127.0.0.1',
  'XFF client with an attached port is not a canonical session owner');
const bracketedIPv6 = await scenario(i => '[2001:db8::20]:' + (5100 + i) + ', 10.0.0.2');
assert.equal(bracketedIPv6[0].status, 200);
assert.equal(bracketedIPv6[0].identity.sessionIdentity, '127.0.0.1',
  'bracketed IPv6 with source port must fall back to reviewed peer identity');

// A syntactically present trusted chain is not necessarily a *valid* chain.
// Empty candidate hops, quoted IP literals and scoped IPv6 identifiers may
// cause ownership to fall back to the peer while Express's limiter sees an
// entirely different client identity. Changing an untrusted prefix must
// never give a new quota for the same TCP peer.
const emptyCandidate = await scenario(i =>
  '203.0.113.' + (i + 10) + ', , 10.0.0.2');
assert.equal(emptyCandidate[0].identity.sessionIdentity, '127.0.0.1',
  'empty XFF candidate hop must not be accepted as a session owner');
const quotedCandidate = await scenario(i =>
  '"198.51.100.' + (i + 10) + '", 10.0.0.2');
assert.equal(quotedCandidate[0].identity.sessionIdentity, '127.0.0.1',
  'quoted XFF IP candidate is not canonical and must fall back');
const ipv6ZoneCandidate = await scenario(i =>
  'fe80::' + (i + 10).toString(16) + '%eth0, 10.0.0.2');
// Node 22's net.isIP() accepts scoped IPv6 literals, even though the
// limiter itself warns about those values. Capture this as a strict-gate
// failure instead of making ordinary evidence-only CI pretend it is safe.
const zoneFallsBack = ipv6ZoneCandidate[0].identity.sessionIdentity === '127.0.0.1';

const matched = incomplete[0].identity.limiterIdentity ===
  incomplete[0].identity.sessionIdentity;
const enforced = incomplete.at(-1).status === 429;
const malformedMatched = malformed[0].identity.limiterIdentity ===
  malformed[0].identity.sessionIdentity;
const malformedEnforced = malformed.at(-1).status === 429;
const portMatched = portTagged[0].identity.limiterIdentity ===
  portTagged[0].identity.sessionIdentity;
const portEnforced = portTagged.at(-1).status === 429;
const ipv6PortMatched = bracketedIPv6[0].identity.limiterIdentity ===
  bracketedIPv6[0].identity.sessionIdentity;
const ipv6PortEnforced = bracketedIPv6.at(-1).status === 429;
const additional = { emptyCandidate, quotedCandidate, ipv6ZoneCandidate };
const additionalParity = Object.fromEntries(Object.entries(additional).map(
  ([name, responses]) => [name, responses[0].identity.limiterIdentity ===
    responses[0].identity.sessionIdentity && responses.at(-1).status === 429]
));
if (strict) {
  assert.deepEqual({ matched, enforced, malformedMatched, malformedEnforced,
    portMatched, portEnforced, ipv6PortMatched, ipv6PortEnforced },
    { matched: true, enforced: true, malformedMatched: true, malformedEnforced: true,
      portMatched: true, portEnforced: true, ipv6PortMatched: true, ipv6PortEnforced: true },
    'source-tethered gateway limiter and session ownership must share a fail-closed key for incomplete or invalid XFF (issue #21)');
  assert.equal(zoneFallsBack, true,
    'scoped IPv6 zone IDs must not become distinct forwarded session owners');
  assert.deepEqual(additionalParity, {
    emptyCandidate: true, quotedCandidate: true, ipv6ZoneCandidate: true
  }, 'malformed quoted, empty and IPv6-zone XFF chains must share quota with session owner');
  console.log('Source-tethered production session limiter identity parity PASS');
} else {
  console.log('Source-tethered gateway session limiter validated for complete chains: ' +
    'limit=' + limit + ', incomplete-chain identityParity=' + matched +
    ', quotaEnforced=' + enforced +
    ', malformed-chain identityParity=' + malformedMatched +
    ', malformed-chain quotaEnforced=' + malformedEnforced +
    ', XFF IPv4-port identityParity=' + portMatched +
    ', IPv4-port quotaEnforced=' + portEnforced +
    ', XFF IPv6-port identityParity=' + ipv6PortMatched +
    ', IPv6-port quotaEnforced=' + ipv6PortEnforced +
    ', IPv6-zone peer fallback=' + zoneFallsBack +
    ', malformed-extra identity/limit parity=' +
    Object.values(additionalParity).filter(Boolean).length + '/3' +
    '; require --require-source-parity for the unresolved issue #21');
}
