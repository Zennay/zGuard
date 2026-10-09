import assert from 'node:assert/strict';
import { requestIp } from '../zbrowse/gateway/request-ip.js';

assert.equal(
  requestIp({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, 1),
  '127.0.0.1',
  'direct requests must use the socket address'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.10' }
  }, 1),
  '203.0.113.10',
  'one trusted reverse proxy must expose its immediate client'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.2' }
  }, 2),
  '198.51.100.20',
  'trusted hop count must select the corresponding client address'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.2' }
  }, 1),
  '10.0.0.2',
  'untrusted forwarded entries must not be skipped'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': '198.51.100.20' }
  }, 2),
  '10.0.0.3',
  'an incomplete forwarded chain must fail closed to the socket address'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.4' },
    headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.1, 10.0.0.2' }
  }, 2),
  '10.0.0.1',
  'extra untrusted entries to the left must not move the trusted-hop boundary'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': '198.51.100.20' }
  }, 0),
  '10.0.0.3',
  'zero trusted hops must ignore forwarding headers'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': 'not-an-ip' }
  }, 1),
  '10.0.0.3',
  'a malformed forwarded client must fail closed to the socket address'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': '198.51.100.20, , 10.0.0.2' }
  }, 2),
  '10.0.0.3',
  'empty forwarded chain entries must not be collapsed across the trust boundary'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': ['198.51.100.20', '10.0.0.2'] }
  }, 2),
  '198.51.100.20',
  'array-form forwarded headers must preserve trusted-hop ordering'
);

assert.equal(
  requestIp({
    socket: { remoteAddress: '::1' },
    headers: { 'x-forwarded-for': '2001:db8::10, 2001:db8::2' }
  }, 2),
  '2001:db8::10',
  'valid IPv6 forwarded clients must remain supported'
);


assert.equal(
  requestIp({ socket: { remoteAddress: '10.0.0.3' }, headers: { 'x-forwarded-for': '198.51.100.20:443' } }, 1),
  '10.0.0.3',
  'forwarded IPs with an embedded port must not be treated as IP addresses'
);

assert.equal(
  requestIp({ socket: { remoteAddress: '10.0.0.3' }, headers: { 'x-forwarded-for': '::ffff:203.0.113.10' } }, 1),
  '::ffff:203.0.113.10',
  'valid IPv4-mapped IPv6 addresses must retain their exact representation'
);

assert.equal(
  requestIp({ socket: { remoteAddress: '10.0.0.3' }, headers: { 'x-forwarded-for': ['198.51.100.20, 10.0.0.1', '10.0.0.2'] } }, 2),
  '10.0.0.1',
  'multiple header fields containing comma chains must preserve right-to-left proxy trust indexing'
);

for (const invalidHops of [-1, 0, 1.5, NaN, '1', null]) {
  assert.equal(
    requestIp({ socket: { remoteAddress: '10.0.0.3' }, headers: { 'x-forwarded-for': '198.51.100.20' } }, invalidHops),
    '10.0.0.3',
    'non-positive or non-integer trustedProxyHops must not trust forwarded headers'
  );
}

assert.equal(
  requestIp({ socket: { remoteAddress: '10.0.0.3' }, headers: { 'x-forwarded-for': { ip: '198.51.100.20' } } }, 1),
  '10.0.0.3',
  'unexpected forwarded-header object values must not be coerced into a client identity'
);

assert.equal(
  requestIp({ socket: { remoteAddress: '10.0.0.3' }, headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.2' } }, 3),
  '10.0.0.3',
  'trusted hop counts longer than the forwarded chain must not select an untrusted entry'
);

console.log('zBrowse request IP tests passed');
