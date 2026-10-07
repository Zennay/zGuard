import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const browser = read('zbrowse/browser/Dockerfile');
const gateway = read('zbrowse/gateway/Dockerfile');
const browserIgnore = read('zbrowse/browser/.dockerignore');
const gatewayIgnore = read('zbrowse/gateway/.dockerignore');

function dockerInstructions(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function assertNoBroadCopy(source, label) {
  const instructions = dockerInstructions(source);

  assert.doesNotMatch(
    instructions,
    /^\s*COPY\s+(?:--\S+\s+)*\.\/?\s+\S+/m,
    `${label} must not copy the entire repository/build context into the image`
  );
  assert.doesNotMatch(
    instructions,
    /^\s*COPY\s*\[\s*["']\.\/?["']\s*,/m,
    `${label} must not use JSON-form broad build-context copies`
  );
}

function ignorePatterns(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

assert.deepEqual(
  ignorePatterns(browserIgnore),
  [
    '**',
    '!Dockerfile',
    '!zguard/',
    '!zguard/**',
    '!policies/',
    '!policies/**',
    '!root/',
    '!root/**'
  ],
  'browser build context must stay default-deny and expose only reviewed Docker inputs'
);

assert.deepEqual(
  ignorePatterns(gatewayIgnore),
  [
    '**',
    '!Dockerfile',
    '!package.json',
    '!package-lock.json',
    '!*.js',
    '!public/',
    '!public/**',
    '!config/',
    '!config/**'
  ],
  'gateway build context must stay default-deny and expose only reviewed Docker inputs'
);

for (const [label, source] of [['browser image', browser], ['gateway image', gateway]]) {
  const instructions = dockerInstructions(source);

  assert.doesNotMatch(instructions, /^\s*ADD\s+/m, `${label} must not use Docker ADD`);
  assert.doesNotMatch(
    instructions,
    /\b(?:curl|wget)\b|\bgit\s+clone\b/,
    `${label} must not use ad-hoc network download commands during the image build`
  );
  assertNoBroadCopy(source, label);
}

assert.match(
  browser,
  /apt-get install -y --no-install-recommends\s+chromium ca-certificates fonts-noto-color-emoji/,
  'browser image must keep its apt dependency surface explicit and recommendation-free'
);
assert.match(
  browser,
  /dpkg-query -W[^\n]*> \/opt\/zbrowse-build-metadata\/apt-packages\.tsv/,
  'browser image must retain installed package provenance'
);
assert.match(
  browser,
  /rm -rf \/var\/lib\/apt\/lists\/\*/,
  'browser image must remove apt package indexes after installation'
);
assert.match(
  browser,
  /COPY zguard \/opt\/zguard/,
  'browser image must copy only the reviewed bundled extension directory'
);
assert.match(
  browser,
  /COPY policies\/policy\.json \/etc\/chromium\/policies\/managed\/zbrowse-policy\.json/,
  'browser image must install the reviewed managed policy explicitly'
);

assert.match(
  gateway,
  /COPY package\.json package-lock\.json \.\//,
  'gateway image must copy dependency manifests before application sources'
);
assert.match(
  gateway,
  /RUN npm ci --omit=dev --ignore-scripts --no-audit && npm cache clean --force/,
  'gateway image must use the locked production dependency graph without lifecycle scripts or implicit audit traffic and clear npm cache'
);
assert.doesNotMatch(
  gateway,
  /\bnpm install\b/,
  'gateway image must not fall back to a mutable npm install'
);
assert.match(
  gateway,
  /ENV NODE_ENV=production/,
  'gateway image must run with production Node semantics'
);
assert.match(
  gateway,
  /^USER node$/m,
  'gateway process must remain non-root'
);
assert.match(
  gateway,
  /^CMD \["node", "server\.js"\]$/m,
  'gateway image must keep an exec-form deterministic entrypoint'
);

console.log('zBrowse image build hygiene contract passed');
