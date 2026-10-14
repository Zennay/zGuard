// The public TV client consumes live gateway capacity, not a static snapshot.
// Execute the shipped /api/health GET handler over 127.0.0.1 HTTP and HEAD;
// synthetic browser-state only, never a production session or external probe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-health-no-store');
const require = createRequire(new URL('../zbrowse/gateway/package.json', import.meta.url));
const express = require('express');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const start = source.indexOf('app.get("/api/health",');
const end = source.indexOf('app.get("/api/sites",', start);
assert.ok(start >= 0 && end > start, 'shipped health response code must be extractable');
const app = express();
const sessions = new Map();
const admission = { pendingCount: 1 };
const config = { maxSessions: 2 };
vm.runInNewContext(source.slice(start, end), {
  app, sessions, sessionAdmission: admission, config
}, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  listening.once('error', reject);
});
try {
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/health';
  async function request(method) {
    // No fetch cache option: validate server-side policy for ordinary clients,
    // rather than passing an explicit no-store instruction in the fixture.
    const reply = await fetch(endpoint, {
      method, redirect: 'error', headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000)
    });
    const body = method === 'HEAD' ? await reply.text() : await reply.json();
    return {
      status: reply.status,
      body,
      cache: reply.headers.get('cache-control'),
      type: reply.headers.get('content-type')
    };
  }
  const starting = await request('GET');
  assert.equal(starting.status, 200);
  assert.match(starting.type ?? '', /^application\/json\b/i);
  assert.deepEqual(starting.body, {
    status: 'ok', activeSessions: 0, startingSessions: 1, capacity: 2
  }, 'real GET readiness must expose starting browser reservations');

  admission.pendingCount = 0;
  sessions.set('synthetic-container', { ip: '127.0.0.1' });
  const active = await request('GET');
  assert.equal(active.status, 200);
  assert.deepEqual(active.body, {
    status: 'ok', activeSessions: 1, startingSessions: 0, capacity: 2
  }, 'repeated GET must reflect updated live resource state');

  const head = await request('HEAD');
  assert.equal(head.status, 200, 'HEAD health must preserve the GET status');
  assert.equal(head.body, '', 'HEAD must never send capacity data in a response body');
  function noStore(value) {
    const parts = String(value || '').toLowerCase().split(',')
      .map(directive => directive.trim());
    return parts.includes('no-store') && !parts.includes('public');
  }
  const protections = [starting, active, head].map(row => noStore(row.cache));
  if (strict) {
    assert.deepEqual(protections, [true, true, true],
      'GET/HEAD live health capacity must prevent intermediary caching (issue #293)');
  }
  console.log('Shipped public health GET/HEAD counter freshness passed; ' +
    'health-cache-no-store=' + protections.filter(Boolean).length +
    '/' + protections.length + '; strict --require-health-no-store still required');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
