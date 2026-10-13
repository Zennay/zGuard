// Execute the *real* Express + express-rate-limit packages against the shipped
// requestIp() resolver. Nothing connects to production or starts Docker.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { requestIp } from '../zbrowse/gateway/request-ip.js';

const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const { rateLimit } = require('express-rate-limit');

// Two independent requests from one TCP source, with forged or incomplete
// forwarding headers, must never buy additional quota for one session owner.
async function scenario(headers) {
  const app = express();
  const trustedHops = 2;
  app.set('trust proxy', trustedHops);
  app.use('/api/session', rateLimit({
    windowMs: 60_000, limit: 1,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'rate limited' }
  }));
  app.post('/api/session', (req, res) => {
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
    const results = [];
    for (const forwarded of headers) {
      const reply = await fetch('http://127.0.0.1:' + server.address().port +
        '/api/session', {
        method: 'POST',
        headers: { 'x-forwarded-for': forwarded }
      });
      results.push({
        status: reply.status,
        identities: reply.status === 200 ? await reply.json() : null
      });
      if (reply.status !== 200) await reply.arrayBuffer();
    }
    return results;
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

const complete = await scenario([
  '192.0.2.5, 198.51.100.20, 10.0.0.2',
  '192.0.2.6, 198.51.100.20, 10.0.0.2'
]);
assert.deepEqual(complete.map((r) => r.status), [200, 429],
  'complete trusted proxy chain must rate-limit a stable session identity');
assert.equal(complete[0].identities.sessionIdentity, '198.51.100.20',
  'actual requestIp() must select the right-side trust boundary');
assert.equal(complete[0].identities.limiterIdentity, '198.51.100.20',
  'Express rate limiter must match a complete trusted proxy chain');

// The same TCP source supplies an incomplete chain shorter than TRUST_PROXY.
// The shipped requestIp() intentionally falls back to req.socket.remoteAddress;
// Express trust proxy can still select an untrusted XFF address for req.ip.
const incomplete = await scenario([
  '198.51.100.20',
  '203.0.113.30'
]);
assert.equal(incomplete[0].status, 200, 'first incomplete-chain request must be admitted');
assert.ok(incomplete[0].identities.sessionIdentity,
  'requestIp() must retain nonempty fallback identity');
assert.notEqual(incomplete[0].identities.sessionIdentity, '198.51.100.20',
  'incomplete chain must not override session identity with forwarded data');

if (process.argv.includes('--require-key-parity')) {
  assert.equal(incomplete[0].identities.limiterIdentity,
    incomplete[0].identities.sessionIdentity,
    'limiter and session identity must agree even with an incomplete trusted proxy chain');
  assert.equal(incomplete[1].status, 429,
    'spoofed/incomplete XFF must not give the same session owner a new rate-limit quota');
  console.log('Live Express rate-limit/session identity parity passed');
} else {
  console.log('Real Express limiter, completed-chain parity and incomplete-chain ' +
    'fallback exercised; strict key parity requires --require-key-parity. ' +
    'Incomplete second request status=' + incomplete[1].status);
}
