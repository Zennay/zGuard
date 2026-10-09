import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../zbrowse/gateway/server.js');
const source = fs.readFileSync(serverPath, 'utf8');

assert.match(
  source,
  /app\.disable\(["']x-powered-by["']\)/,
  'gateway must keep the Express X-Powered-By header disabled'
);

const helmetStart = source.indexOf('app.use(helmet({');
const jsonStart = source.indexOf('app.use(express.json', helmetStart);
assert.notEqual(helmetStart, -1, 'gateway must install helmet middleware');
assert.notEqual(jsonStart, -1, 'helmet must be configured before JSON request parsing');

const helmetBlock = source.slice(helmetStart, jsonStart);

function assertHelmetDefaultsRemainEnabled(block, label) {
  assert.doesNotMatch(
    block,
    /useDefaults\s*:\s*false/,
    `${label}: Helmet CSP defaults must remain enabled`
  );

  const protectedOptions = [
    'contentSecurityPolicy',
    'crossOriginOpenerPolicy',
    'crossOriginResourcePolicy',
    'originAgentCluster',
    'referrerPolicy',
    'strictTransportSecurity',
    'hsts',
    'xContentTypeOptions',
    'noSniff',
    'xDnsPrefetchControl',
    'dnsPrefetchControl',
    'xDownloadOptions',
    'ieNoOpen',
    'xFrameOptions',
    'frameguard',
    'xPermittedCrossDomainPolicies',
    'permittedCrossDomainPolicies',
    'xXssProtection',
    'xssFilter'
  ];

  for (const option of protectedOptions) {
    assert.doesNotMatch(
      block,
      new RegExp(`\\b${option}\\s*:\\s*false\\b`),
      `${label}: Helmet security option ${option} must not be disabled`
    );
  }
}

assert.doesNotThrow(() =>
  assertHelmetDefaultsRemainEnabled(
    'contentSecurityPolicy: { directives: {} }, crossOriginEmbedderPolicy: false',
    'self-test enabled defaults'
  )
);
assert.throws(
  () => assertHelmetDefaultsRemainEnabled('contentSecurityPolicy: { useDefaults: false }', 'self-test CSP defaults'),
  /CSP defaults must remain enabled/
);
assert.throws(
  () => assertHelmetDefaultsRemainEnabled('xFrameOptions: false', 'self-test frame protection'),
  /xFrameOptions must not be disabled/
);

assertHelmetDefaultsRemainEnabled(helmetBlock, 'gateway helmet configuration');
assert.match(
  helmetBlock,
  /crossOriginEmbedderPolicy\s*:\s*false/,
  'gateway must keep the intentional COEP exception explicit for the proxied browser stream'
);

for (const [directive, expected] of [
  ['defaultSrc', `["'self'"]`],
  ['scriptSrc', `["'self'"]`],
  ['styleSrc', `["'self'"]`],
  ['imgSrc', `["'self'", "data:"]`],
  ['frameSrc', `["'self'"]`],
  ['connectSrc', `["'self'", "wss:", "ws:"]`],
  ['mediaSrc', `["'self'", "blob:"]`]
]) {
  assert.ok(
    helmetBlock.includes(`${directive}: ${expected}`),
    `helmet CSP must preserve ${directive}=${expected}`
  );
}

assert.equal(
  helmetBlock.includes("'unsafe-inline'"),
  false,
  'CSP must not allow unsafe-inline scripts or styles'
);
assert.equal(
  helmetBlock.includes("'unsafe-eval'"),
  false,
  'CSP must not allow unsafe-eval'
);
assert.equal(
  /(?:^|[\s,[{])["']\*["'](?:[\s,}\]])/.test(helmetBlock),
  false,
  'CSP must not introduce wildcard sources'
);
assert.match(
  source,
  /express\.json\(\{\s*limit:\s*["']8kb["']\s*\}\)/,
  'JSON request bodies must remain capped at 8kb'
);

console.log('zBrowse security header contract tests passed');
