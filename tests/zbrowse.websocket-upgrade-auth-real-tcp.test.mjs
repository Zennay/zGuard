// Real TCP WebSocket upgrade acceptance for the shipped gateway auth path.
// Uses only loopback sockets and synthetic bearer values, never Docker/VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { requestIp } from '../zbrowse/gateway/request-ip.js';
import { requestPath } from '../zbrowse/gateway/request-path.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strictOrigin = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-websocket-origin');

const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
function segment(begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, 'shipped gateway WebSocket source must be extractable');
  return source.slice(start, stop);
}
const token = 'W'.repeat(32); // synthetic, never a production session credential
const ip = '127.0.0.1';
const session = {
  token, ip, password: 'synthetic-only',
  containerName: 'test-browser',
  expiresAt: Date.now() + 600_000,
  lastSeenAt: 0,
  expired: false
};
const sessions = new Map([[token, session]]);
const server = http.createServer((_req, res) => {
  res.writeHead(404).end('No non-upgrade session endpoint is available in this fixture');
});
const seen = [];
const sandbox = {
  server, sessions, requestIp, requestPath, trustProxyHops: 0,
  config: { idleMs: 300_000 },
  isSessionExpired(value) { return Boolean(value.expired); },
  console: { error(...args) { throw new Error('unexpected proxy error: ' + args.join(' ')); } },
  browserProxy: {
    async ws(req, socket, options, head) {
      seen.push({
        target: options.target,
        auth: options.auth,
        session: req.zbrowseSession,
        url: req.url,
        headLength: head.length
      });
      socket.end('HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Accept: fixture-only\r\n\r\n');
    }
  }
};
const code = [
  segment('function findSession(req) {', 'app.get("/api/health"'),
  segment('function browserProxyOptions(req) {', 'app.use("/s/", async (req, res) => {'),
  segment('server.on("upgrade", (req, socket, head) => {', 'server.listen(config.port,')
].join('\n');
vm.runInNewContext(code, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
assert.equal(server.listenerCount('upgrade'), 1,
  'shipped gateway must register one explicit WebSocket authorization boundary');

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, ip, resolve);
});
const port = server.address().port;
const open = async (requestPathValue, extraHeaders = '') => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: ip, port });
  let received = '';
  let settled = false;
  const complete = (error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (error) reject(error);
    else resolve(received);
  };
  socket.setTimeout(4000, () => complete(new Error('local WebSocket fixture timed out')));
  socket.once('connect', () => {
    socket.write('GET ' + requestPathValue + ' HTTP/1.1\r\n' +
      'Host: 127.0.0.1:' + port + '\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n' + extraHeaders + '\r\n');
  });
  socket.on('data', data => { received += data.toString('utf8'); });
  socket.once('end', () => complete());
  socket.once('close', () => complete());
  socket.once('error', error =>
    error.code === 'ECONNRESET' ? complete() : complete(error));
});

try {
  const accepted = await open('/s/' + token + '/websockify?screen=1');
  assert.match(accepted, /^HTTP\/1\.1 101 Switching Protocols/m,
    'valid session owner must reach real TCP WebSocket upgrade');
  assert.equal(seen.length, 1, 'approved upgrade must forward exactly once');
  assert.equal(seen[0].session, session, 'forwarded request must be bound to stored session');
  assert.equal(seen[0].target, 'https://test-browser:3001',
    'authenticated WebSocket must use the selected container only');
  assert.equal(seen[0].auth, 'viewer:synthetic-only',
    'upstream authorization must be derived from stored session, never user headers');
  assert.equal(seen[0].url, '/s/' + token + '/websockify?screen=1',
    'upgrade proxy must preserve exact raw path and query');

  const unknown = await open('/s/' + 'U'.repeat(32) + '/websockify');
  assert.doesNotMatch(unknown, /^HTTP\/1\.1 101/m,
    'unknown token must be terminated without upstream handshake');
  assert.equal(seen.length, 1, 'unknown token must never reach upstream');

  const malformed = await open('/s/' + token.slice(0, 31) + '/websockify');
  assert.doesNotMatch(malformed, /^HTTP\/1\.1 101/m,
    'short bearer tokens may not authenticate WebSocket upgrades');
  assert.equal(seen.length, 1);

  session.expired = true;
  const expired = await open('/s/' + token + '/websockify');
  assert.doesNotMatch(expired, /^HTTP\/1\.1 101/m,
    'expired session must not upgrade');
  assert.equal(seen.length, 1);
  session.expired = false;

  session.ip = '192.0.2.55';
  const stolen = await open('/s/' + token + '/websockify',
    'X-Forwarded-For: 192.0.2.55\r\n');
  assert.doesNotMatch(stolen, /^HTTP\/1\.1 101/m,
    'forged forwarding headers must not override the TCP session owner');
  assert.equal(seen.length, 1, 'cross-owner token must never reach the upstream');
  session.ip = ip;

  const restored = await open('/s/' + token + '/websockify');
  assert.match(restored, /^HTTP\/1\.1 101/m,
    'a valid session must remain usable after rejected attackers');
  assert.equal(seen.length, 2, 'only two legitimate upgrades should be forwarded');

  // Browser WebSocket handshakes carry Origin but do not use CORS preflight.
  // The same peer can have another, unrelated web page. The server must not
  // assume token ownership is sufficient to authorize that page's upgrade.
  const target = '/s/' + token + '/websockify?screen=1';
  const beforeForeign = seen.length;
  const foreign = await open(target,
    'Origin: https://attacker.invalid\r\nSec-Fetch-Site: cross-site\r\n');
  const sandboxed = await open(target,
    'Origin: null\r\nSec-Fetch-Site: cross-site\r\n');
  const metadataOnly = await open(target,
    'Sec-Fetch-Site: cross-site\r\n');
  const newUpgrades = seen.length - beforeForeign;
  const foreignAccepted = /^HTTP\/1\.1 101/m.test(foreign);
  const sandboxedAccepted = /^HTTP\/1\.1 101/m.test(sandboxed);
  const metadataAccepted = /^HTTP\/1\.1 101/m.test(metadataOnly);
  if (strictOrigin) {
    assert.deepEqual({ foreignAccepted, sandboxedAccepted, metadataAccepted, newUpgrades },
      { foreignAccepted: false, sandboxedAccepted: false,
        metadataAccepted: false, newUpgrades: 0 },
      'cross-site WebSocket upgrades must be rejected before reaching browser proxy (issue #342)');
    console.log('Shipped real TCP WebSocket cross-site Origin isolation passed');
  } else {
    console.log('Shipped real TCP WebSocket owner/isolation controls passed; ' +
      'foreign Origin upgraded=' + foreignAccepted +
      ', Origin:null upgraded=' + sandboxedAccepted +
      ', cross-site metadata upgraded=' + metadataAccepted +
      ', untrusted browser proxy forwards=' + newUpgrades +
      ' (strict --require-websocket-origin is not a runtime fix)');
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}
