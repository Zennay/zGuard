import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const browser = read('zbrowse/browser/Dockerfile');
const gateway = read('zbrowse/gateway/Dockerfile');

function assertNoBroadCopy(source, label) {
  assert.doesNotMatch(
    source,
    /^\s*(?:COPY|ADD)\s+(?:--[^\n]+\s+)*\.\s+\.?\/?\s*$/m,
    `${label} must not copy the entire repository/build context into the image`
  );
}

for (const [label, source] of [['browser image', browser], ['gateway image', gateway]]) {
  assert.doesNotMatch(source, /^\s*ADD\s+/m, `${label} must not use Docker ADD`);
  assert.doesNotMatch(
    source,
    /\b(?:curl|wget)\b[^\n]*https?:\/\//,
    `${label} must not fetch unverified remote build artifacts`
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
  /RUN npm ci --omit=dev && npm cache clean --force/,
  'gateway image must use the locked production dependency graph and clear npm cache'
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
