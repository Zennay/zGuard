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

console.log('zBrowse request path tests passed');
