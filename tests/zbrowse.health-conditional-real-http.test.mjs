// Real Express conditional HTTP acceptance for changing gateway capacity.
// A 304 response is legitimate only when its validator still describes the
// current body; all 200/304/HEAD variants must preserve server-side no-store.
// Uses shipped route on loopback, with synthetic counters and zero Docker.
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
assert.ok(start >= 0 && end > start, 'actual shipped health route must be extractable');

const app = express();
const sessions = new Map();
const sessionAdmission = { pendingCount: 1 };
const config = { maxSessions: 2 };
vm.runInNewContext(source.slice(start, end), {
  app, sessions, sessionAdmission, config
}, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  listening.once('error', reject);
});
try {
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/health';
  async function request(method, etag = null) {
    const headers = { accept: 'application/json' };
    if (etag !== null) headers['if-none-match'] = etag;
    const reply = await fetch(endpoint, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(4000)
    });
    const text = await reply.text();
    const data = reply.status === 200 && method === 'GET' ? JSON.parse(text) : null;
    return {
      method, status: reply.status, text, data,
      etag: reply.headers.get('etag'),
      cache: reply.headers.get('cache-control'),
      contentType: reply.headers.get('content-type')
    };
  }

  const rows = [];
  const initial = await request('GET');
  rows.push(initial);
  assert.equal(initial.status, 200, 'initial live health must return a JSON body');
  assert.match(initial.contentType || '', /^application\/json\b/i);
  assert.deepEqual(initial.data, {
    status: 'ok', activeSessions: 0, startingSessions: 1, capacity: 2
  });

  const initialHead = await request('HEAD');
  rows.push(initialHead);
  assert.equal(initialHead.status, 200, 'unconditional HEAD must be a successful capacity probe');
  assert.equal(initialHead.text, '', 'HEAD must not disclose a body');

  if (initial.etag) {
    // Express by default responds 304 to matching conditional GET and HEAD.
    // This is permitted HTTP behaviour if the validator is truthful and the
    // appropriate cache instructions are still present on every response.
    const repeat = await request('GET', initial.etag);
    rows.push(repeat);
    assert.ok([200, 304].includes(repeat.status),
      'conditional GET must be successful or not-modified, never a transient error');
    if (repeat.status === 304) {
      assert.equal(repeat.text, '', '304 must have no response body');
    } else {
      assert.deepEqual(repeat.data, initial.data,
        'conditional 200 must describe the same current capacity');
    }

    const matchingHead = await request('HEAD', initial.etag);
    rows.push(matchingHead);
    assert.ok([200, 304].includes(matchingHead.status));
    assert.equal(matchingHead.text, '', 'conditional HEAD has no response body');
  }

  // Change live state between polls. A conditional request with an old
  // validator must not receive a stale 304 after counters change.
  sessionAdmission.pendingCount = 0;
  sessions.set('synthetic-browser', { ip: '127.0.0.1' });
  const updated = await request('GET', initial.etag);
  rows.push(updated);
  assert.equal(updated.status, 200,
    'an old capacity ETag must not hide new active browser state behind 304');
  assert.deepEqual(updated.data, {
    status: 'ok', activeSessions: 1, startingSessions: 0, capacity: 2
  });
  if (initial.etag && updated.etag) {
    assert.notEqual(updated.etag, initial.etag, 'changed browser counts need a new ETag');
    const latestConditional = await request('GET', updated.etag);
    rows.push(latestConditional);
    assert.ok([200, 304].includes(latestConditional.status));
    if (latestConditional.status === 200) {
      assert.deepEqual(latestConditional.data, updated.data);
    } else {
      assert.equal(latestConditional.text, '');
    }
    const latestHead = await request('HEAD', updated.etag);
    rows.push(latestHead);
    assert.ok([200, 304].includes(latestHead.status));
    assert.equal(latestHead.text, '');
  }

  const finalHead = await request('HEAD', initial.etag);
  rows.push(finalHead);
  assert.equal(finalHead.status, 200,
    'a stale conditional HEAD must not report unchanged resource capacity');
  assert.equal(finalHead.text, '');

  function preventsStorage(cache) {
    const directives = String(cache || '').toLowerCase().split(',').map(x => x.trim());
    return directives.includes('no-store') && !directives.includes('public');
  }
  const protectedRows = rows.filter(row => preventsStorage(row.cache));
  if (strict) {
    assert.equal(protectedRows.length, rows.length,
      'every conditional/unconditional 200/304 GET/HEAD health response must prohibit storage (issue #293)');
  }
  console.log('Real gateway conditional health freshness: ' + rows.length +
    ' GET/HEAD responses; Etags ' + (initial.etag ? 'enabled' : 'disabled') +
    '; server no-store=' + protectedRows.length + '/' + rows.length +
    '; exact --require-health-no-store proves storage policy only when opted in');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
