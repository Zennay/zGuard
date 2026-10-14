// Source-bound HTTP acceptance for the two public GET endpoints consumed by
// the read-only TV readiness probe. No public requests, sessions, or Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const sites = JSON.parse(fs.readFileSync(
  new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8'));
const start = source.indexOf('app.get("/api/health",');
const end = source.indexOf('app.post("/api/session",', start);
assert.ok(start >= 0 && end > start, 'actual public gateway API routes must remain extractable');
const app = express();
const sessions = new Map();
const pending = { pendingCount: 1 };
const config = { maxSessions: 2, ttlMs: 900_000 };
vm.runInNewContext(source.slice(start, end), {
  app, sessions, sessionAdmission: pending, config, sites, Math
}, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  listening.once('error', reject);
});
try {
  async function get(route) {
    const response = await fetch('http://127.0.0.1:' + server.address().port +
      route, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(4000)
    });
    assert.equal(response.status, 200, route + ': public GET should return HTTP 200');
    assert.match(response.headers.get('content-type') || '', /^application\/json\b/i,
      route + ': actual Express response must use JSON media type');
    return response.json();
  }

  const first = await get('/api/health');
  assert.deepEqual(first, {
    status: 'ok', activeSessions: 0, startingSessions: 1, capacity: 2
  }, 'public readiness must report both existing and pending browser capacity');
  sessions.set('synthetic-only', { ip: '127.0.0.1' });
  pending.pendingCount = 0;
  const changed = await get('/api/health');
  assert.deepEqual(changed, {
    status: 'ok', activeSessions: 1, startingSessions: 0, capacity: 2
  }, 'health must derive live counters, not return cached or fabricated availability');

  const catalogue = await get('/api/sites');
  assert.equal(catalogue.maxSessionMinutes, 15,
    'published session duration must derive from actual configured TTL');
  assert.deepEqual(catalogue.sites, sites,
    'public site catalogue must exactly reflect source-controlled gateway policy');
  for (const site of catalogue.sites) {
    const parsed = new URL(site.url);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');
  }

  console.log('Shipped gateway /api/health and /api/sites real HTTP contract passed; ' +
    'public TV HTTPS routing still requires separate live proof (issue #293)');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
