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

const matched = incomplete[0].identity.limiterIdentity ===
  incomplete[0].identity.sessionIdentity;
const enforced = incomplete.at(-1).status === 429;
if (strict) {
  assert.deepEqual({ matched, enforced }, { matched: true, enforced: true },
    'source-tethered gateway rate limiter and session ownership diverge on forged incomplete XFF (issue #21)');
  console.log('Source-tethered production session limiter identity parity PASS');
} else {
  console.log('Source-tethered gateway session limiter validated for complete chains: ' +
    'limit=' + limit + ', incomplete-chain identityParity=' + matched +
    ', quotaEnforced=' + enforced +
    '; require --require-source-parity for the unresolved issue #21');
}
