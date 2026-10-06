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

console.log('zBrowse request IP tests passed');
