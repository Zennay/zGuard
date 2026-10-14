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

// Exhaustively exercise trusted-hop selection over longer proxy chains.
// Malicious entries on the untrusted LEFT side must not change the client
// selected from the configured RIGHT-side trust boundary.
const socketAddress = '10.0.0.250';
const addresses = [
  '203.0.113.10',
  '198.51.100.21',
  '192.0.2.32',
  '2001:db8::43',
  '10.1.2.4',
  '::ffff:198.51.100.55',
  '172.20.0.6'
];
for (let length = 1; length <= addresses.length; length += 1) {
  const chain = addresses.slice(0, length);
  for (let hops = 1; hops <= length + 2; hops += 1) {
    const header = chain.join(', ');
    const req = { socket: { remoteAddress: socketAddress }, headers: { 'x-forwarded-for': header } };
    const expected = hops <= chain.length ? chain[chain.length - hops] : socketAddress;
    assert.equal(
      requestIp(req, hops),
      expected,
      `length ${length}, hops ${hops}: resolver must select the correct right-side boundary`
    );

    if (hops <= length) {
      for (const prefix of [
        '8.8.8.8',
        '8.8.8.8, 1.1.1.1',
        '8.8.8.8, 1.1.1.1, 9.9.9.9'
      ]) {
        assert.equal(
          requestIp({
            socket: { remoteAddress: socketAddress },
            headers: { 'x-forwarded-for': prefix + ', ' + header }
          }, hops),
          expected,
          'additional untrusted LEFT-side entries must not influence the trusted client'
        );
      }

      const split = Math.max(1, Math.floor(length / 2));
      assert.equal(
        requestIp({
          socket: { remoteAddress: socketAddress },
          headers: {
            'x-forwarded-for': [
              chain.slice(0, split).join(','),
              chain.slice(split).join(',')
            ].filter(Boolean)
          }
        }, hops),
        expected,
        'multiple header fields must preserve original right-to-left hop ordering'
      );
    }
  }
}

// A forged/malformed address AT the selected trust boundary must never be
// replaced by an attacker-supplied address farther to its left.
for (const malformed of [
  '999.999.999.999', '10.0.0.2:443', '[2001:db8::1]',
  'unknown', ' ', '203.0.113.1\nInjected-Header: yes'
]) {
  assert.equal(
    requestIp({
      socket: { remoteAddress: socketAddress },
      headers: { 'x-forwarded-for': '8.8.8.8, ' + malformed + ', 10.0.0.2' }
    }, 2),
    socketAddress,
    'malformed selected forwarded IP must fail closed to the socket'
  );
}

// The session owner must never trust alternate client-IP headers or
// noncanonical spellings of IP literals at the reviewed two-hop boundary.
// Proxies and rate-limit middleware may interpret those values differently;
// assert the actual gateway resolver's deterministic TCP fallback here.
const invalidBoundaryValues = [
  ['quoted IPv4', '"198.51.100.20"'],
  ['quoted IPv6', '"2001:db8::20"'],
  ['IPv4 with source port', '198.51.100.20:4100'],
  ['bracketed IPv6 and port', '[2001:db8::20]:4100'],
  ['IPv6 zone suffix', 'fe80::1%eth0'],
  ['shortened IPv4', '127.1'],
  ['decimal IPv4', '2130706433'],
  ['hexadecimal IPv4', '0x7f000001'],
  ['octal IPv4', '0177.0.0.1'],
  ['ASCII NUL', '198.51.100.20\\u0000extra'.replace('\\u0000', '\u0000')],
  ['nested comma', '198.51.100.20,,10.0.0.2']
];
let checkedBoundary = 0;
for (const [label, value] of invalidBoundaryValues) {
  const forwarded = '203.0.113.77, ' + value + ', 10.0.0.2';
  const req = {
    socket: { remoteAddress: '10.0.0.3' },
    headers: { 'x-forwarded-for': forwarded }
  };
  assert.equal(requestIp(req, 2), '10.0.0.3',
    label + ': invalid forwarded client must not create a new session owner');
  checkedBoundary++;
}

// RFC 7239 Forwarded and vendor X-Real-IP must never override the selected
// X-Forwarded-For chain or manufacture a client when that chain is absent.
for (const metadata of [
  { forwarded: 'for=203.0.113.11' },
  { 'x-real-ip': '203.0.113.11' },
  { forwarded: 'for=203.0.113.11', 'x-real-ip': '203.0.113.12' }
]) {
  assert.equal(requestIp({
    socket: { remoteAddress: '10.0.0.3' }, headers: metadata
  }, 2), '10.0.0.3',
  'untrusted alternate proxy headers must not define session ownership');
  assert.equal(requestIp({
    socket: { remoteAddress: '10.0.0.3' },
    headers: { ...metadata, 'x-forwarded-for': '198.51.100.20, 10.0.0.2' }
  }, 2), '198.51.100.20',
  'validated XFF trust boundary must take precedence over alternate headers');
}

console.log('Noncanonical XFF trust-boundary cases checked=' + checkedBoundary);

console.log('zBrowse request IP tests passed');
