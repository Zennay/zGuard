// Source-bound gateway WebSocket error-path privacy acceptance over real loopback TCP.
// Synthetic errors only: never contacts a public viewer, real Docker or VPS.
// Baseline measures current behavior; strict opt-in is a runtime remediation gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { requestPath } from '../zbrowse/gateway/request-path.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2),
  '--require-redacted-ws-proxy-errors');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function segment(begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start,
    'shipped gateway authenticated WebSocket and logger source must be extractable');
  return source.slice(start, stop);
}

const ip = '127.0.0.1';
const token = 'Y'.repeat(32); // nonsecret synthetic session identifier
const password = 'qa-websocket-password-only';
const basic = Buffer.from('viewer:' + password).toString('base64');
const session = {
  token, password, ip, containerName: 'qa-websocket-browser',
  expiresAt: Date.now() + 600_000, lastSeenAt: 0
};
const sessions = new Map([[token, session]]);
const errors = [
  new Error('WS upstream failed at /s/' + token +
    '/websockify Authorization: Basic ' + basic),
  new Error('wss://sample-user:sample-pass@fixture.invalid/s/' + token +
    '/websockify?password=' + password),
  new Error('WS failure\n[INFO] forged reconnect complete /s/' + token),
  new Error('WS failed\u001b[2J\u001b[H[OK] forged healthy\u2028PASSWORD=' + password)
];
const recorded = [];
let forwards = 0;
const server = http.createServer((_req, res) => {
  res.writeHead(404).end('No public HTTP browser endpoint in this fixture');
});
const sandbox = {
  server, sessions, requestIp, requestPath, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired() { return false; },
  console: { error(...args) { recorded.push(args.map(String).join(' ')); } },
  browserProxy: {
    async ws(req, socket, options, head) {
      forwards++;
      assert.equal(req.zbrowseSession, session,
        'only current owner may reach the shipped WebSocket forwarding path');
      assert.equal(options.auth, 'viewer:' + password,
        'upstream auth must come from stored gateway session');
      assert.equal(options.target, 'https://qa-websocket-browser:3001',
        'WebSocket proxy must target the bound container only');
      assert.equal(head.length, 0, 'fixture sends no pipelined WebSocket frames');
      const error = errors.shift();
      if (error) throw error;
      socket.end('HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Accept: synthetic-only\r\n\r\n');
    }
  }
};
const handlers = [
  segment('function findSession(req) {', 'app.get("/api/health"'),
  segment('function browserProxyOptions(req) {', 'app.use("/s/", async (req, res) => {'),
  segment('server.on("upgrade", (req, socket, head) => {', 'server.listen(config.port,')
].join('\n');
assert.match(handlers, /function browserProxyError\(/,
  'the tested WebSocket error callback must be the shipped error logger');
vm.runInNewContext(handlers, sandbox, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
assert.equal(server.listenerCount('upgrade'), 1,
  'exactly one shipped WebSocket upgrade callback must be installed');

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, ip, resolve);
});
const port = server.address().port;
async function handshake(pathname, extraHeaders = '') {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    let response = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    socket.setTimeout(4000, () => finish(new Error('local TCP WebSocket test timed out')));
    socket.once('connect', () => {
      socket.write('GET ' + pathname + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:' + port + '\r\n' +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' + extraHeaders + '\r\n');
    });
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.once('end', () => finish());
    socket.once('close', () => finish());
    socket.once('error', error =>
      error.code === 'ECONNRESET' ? finish() : finish(error));
  });
}

try {
  const viewer = '/s/' + token + '/websockify?screen=1';
  const invalid = await handshake('/s/' + 'X'.repeat(32) + '/websockify');
  assert.doesNotMatch(invalid, /^HTTP\/1\.1 101/m,
    'unknown bearer must be rejected before WebSocket proxying');
  assert.equal(forwards, 0);
  assert.equal(recorded.length, 0,
    'denied tokens must not produce an upstream error diagnostic');

  for (let i = 0; i < 4; i++) {
    const refused = await handshake(viewer);
    assert.doesNotMatch(refused, /^HTTP\/1\.1 101/m,
      'synthetic upstream exception must never upgrade the client socket');
  }
  assert.equal(forwards, 4, 'every allowed handshake must reach real proxy callback');
  assert.equal(recorded.length, 4, 'every WebSocket exception must record a diagnostic');
  assert.ok(recorded.every(line => line.includes('Browser proxy error')),
    'diagnostics must still retain a generic, actionable proxy-failure category');

  session.ip = '192.0.2.99';
  const otherOwner = await handshake(viewer, 'X-Forwarded-For: 192.0.2.99\r\n');
  assert.doesNotMatch(otherOwner, /^HTTP\/1\.1 101/m,
    'forged owner headers must not authorize WebSocket upgrade');
  assert.equal(forwards, 4);
  session.ip = ip;
  const recovered = await handshake(viewer);
  assert.match(recovered, /^HTTP\/1\.1 101 Switching Protocols/m,
    'authorized viewer upgrade must recover after synthetic upstream failures');
  assert.equal(forwards, 5);
  assert.equal(recorded.length, 4, 'successful recovery must not add an error diagnostic');

  // Inspect only in memory. Never emit tokens, auth strings, or log payloads
  // in CI output, even when the strict remediation check fails.
  const canaries = [token, password, basic, 'sample-user', 'sample-pass'];
  const leaking = recorded.filter(line =>
    canaries.some(needle => line.includes(needle)) ||
    /[\r\n\x1b\u2028\u2029]/.test(line));
  if (strict) {
    assert.equal(leaking.length, 0,
      'WebSocket proxy diagnostics must not expose upstream credentials, bearer paths or forged log lines');
  }
  console.log('Shipped real-TCP WebSocket proxy-error privacy: synthetic failures=' +
    recorded.length + ', safe diagnostics=' + (recorded.length - leaking.length) +
    '/' + recorded.length +
    '; strict remediation proof: --require-redacted-ws-proxy-errors');
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
