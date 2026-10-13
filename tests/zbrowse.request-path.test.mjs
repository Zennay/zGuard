import assert from 'node:assert/strict';
import { requestPath } from '../zbrowse/gateway/request-path.js';

assert.equal(
  requestPath({ originalUrl: '/s/token/ws', url: '/ignored' }),
  '/s/token/ws',
  'Express originalUrl must take precedence'
);
assert.equal(
  requestPath({ url: '/s/token/ws' }),
  '/s/token/ws',
  'raw WebSocket upgrades must fall back to req.url'
);
assert.equal(
  requestPath({}, '/fallback'),
  '/fallback',
  'proxy path rewriting must preserve its provided fallback'
);


assert.equal(
  requestPath({ originalUrl: '/s/token/ws?upgrade=1', url: '/rewritten' }, '/proxy'),
  '/s/token/ws?upgrade=1',
  'original URL query strings must be retained without routing rewrites'
);
assert.equal(
  requestPath({ originalUrl: '', url: '/raw?x=1' }, '/fallback'),
  '/raw?x=1',
  'an empty originalUrl must fall back to the raw URL'
);
assert.equal(
  requestPath({ originalUrl: '', url: '' }, '/fallback'),
  '/fallback',
  'both absent URL fields must preserve the explicit proxy fallback'
);
assert.equal(
  requestPath(null, '/fallback'),
  '/fallback',
  'requests without an object must preserve the explicit fallback'
);
assert.equal(
  requestPath({ originalUrl: '/%2e%2e/admin', url: '/sanitized' }),
  '/%2e%2e/admin',
  'requestPath must return the original encoded value without introducing an alternate normalized route'
);

// The gateway proxy forwards the original raw request target. Parsing,
// unescaping or reconstructing it here can alter a browser stream's route or
// query signature. Validate byte-for-byte selection for both HTTP and WS paths.
const rawTargets = [
  '/s/token/',
  '/s/token/ws?EIO=4&transport=websocket',
  '/s/%2f%2Ftoken/path',
  '/s/token/%2e%2e/admin',
  '/s/token/?sig=a%2Bb%3Dc&space=%20',
  '/s/token/?list=one&list=two',
  '/s/token/file;param=1',
  '/s/token//double/slash',
  '//double-leading/slash',
  '/s/token/%25percent%00nul',
  '/s/token/你好?encoded=%E4%BD%A0%E5%A5%BD',
  '/s/token/?blank=&flag'
];
let verified = 0;
for (const target of rawTargets) {
  const rewritten = '/gateway/rewritten';
  const originalRequest = { originalUrl: target, url: rewritten };
  assert.equal(
    requestPath(originalRequest, '/fallback'),
    target,
    'Express originalUrl must remain byte-for-byte authoritative'
  );
  assert.equal(
    requestPath({ url: target }, '/fallback'),
    target,
    'raw WebSocket URL must preserve the complete unparsed target'
  );
  assert.equal(
    requestPath({ originalUrl: '', url: target }, '/fallback'),
    target,
    'empty originalUrl must preserve the unmodified upgrade URL'
  );
  verified += 3;
}
for (const fallback of ['/fallback', '/s/fallback/ws?x=%2F', '']) {
  for (const request of [null, undefined, {}, { originalUrl: '', url: '' }]) {
    assert.equal(
      requestPath(request, fallback),
      fallback,
      'missing request URLs must not override caller-provided fallback'
    );
    verified += 1;
  }
}
console.log(`zBrowse raw proxy request path matrix passed ${verified} cases`);

console.log('zBrowse request path tests passed');
