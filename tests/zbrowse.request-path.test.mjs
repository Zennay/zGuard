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

console.log('zBrowse request path tests passed');
