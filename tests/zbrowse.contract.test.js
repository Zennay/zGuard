const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

const compose = read('zbrowse/docker-compose.yml');
const gatewayDockerfile = read('zbrowse/gateway/Dockerfile');
const envText = read('zbrowse/.env.example');
const sites = json('zbrowse/gateway/config/sites.json');
const policy = json('zbrowse/browser/policies/policy.json');
const chromium = json('chromium/manifest.json');
const firefox = json('firefox/manifest.json');

assert.match(
  compose,
  /127\.0\.0\.1:\$\{PORT:-8090\}:\$\{PORT:-8090\}/,
  'zBrowse gateway must publish only on loopback by default'
);
assert.doesNotMatch(
  compose,
  /^\s*-\s*["']?\$\{PORT:-8090\}:\$\{PORT:-8090\}["']?\s*$/m,
  'zBrowse gateway must not expose the host port on every interface'
);
assert.match(compose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
assert.match(compose, /\.\/gateway\/config:\/app\/config:ro/);

assert.match(
  gatewayDockerfile,
  /COPY package\.json package-lock\.json \.\//,
  'gateway image must include the lockfile'
);
assert.match(
  gatewayDockerfile,
  /RUN npm ci --omit=dev/,
  'gateway image must install the locked production dependency graph'
);
assert.match(
  gatewayDockerfile,
  /COPY server\.js request-ip\.js \.\//,
  'gateway image must include every local runtime module'
);

assert.ok(Array.isArray(sites) && sites.length > 0, 'at least one site must be configured');
const seenHosts = new Set();
for (const site of sites) {
  assert.equal(typeof site.name, 'string');
  const url = new URL(site.url);
  assert.equal(url.protocol, 'https:', `${site.name}: only HTTPS sites are allowed`);
  assert.ok(!seenHosts.has(url.hostname), `${site.name}: duplicate hostname`);
  seenHosts.add(url.hostname);
  const exact = `https://${url.hostname}/*`;
  const wildcard = `https://*.${url.hostname}/*`;
  assert.ok(
    policy.URLAllowlist.includes(exact) || policy.URLAllowlist.includes(wildcard),
    `${site.name}: browser policy must allow the configured host`
  );
}

assert.deepEqual(policy.URLBlocklist, ['*'], 'browser policy must deny by default');
assert.equal(policy.DownloadRestrictions, 3, 'downloads must remain disabled');
assert.equal(policy.PasswordManagerEnabled, false);
assert.equal(policy.BrowserGuestModeEnabled, false);
assert.equal(policy.BrowserAddPersonEnabled, false);
assert.equal(policy.AutofillAddressEnabled, false);
assert.equal(policy.AutofillCreditCardEnabled, false);
assert.equal(policy.DefaultPopupsSetting, 2, 'browser-level popups must remain blocked');
assert.ok(policy.SafeBrowsingProtectionLevel >= 1, 'Safe Browsing must remain enabled');

const envStart = envText.match(/^START_URL=(.+)$/m)?.[1];
assert.ok(envStart, '.env.example must declare START_URL');
assert.ok(
  sites.some((site) => new URL(site.url).hostname === new URL(envStart).hostname),
  'default START_URL must be represented in gateway sites.json'
);

assert.equal(chromium.name, firefox.name, 'browser packages must keep the same product name');
assert.equal(chromium.version, firefox.version, 'browser packages must keep the same version');
assert.equal(chromium.manifest_version, 3);
assert.equal(firefox.manifest_version, 2);
assert.equal(chromium.content_scripts[0].run_at, 'document_start');
assert.equal(firefox.content_scripts[0].run_at, 'document_start');
assert.equal(chromium.content_scripts[0].all_frames, true);
assert.equal(firefox.content_scripts[0].all_frames, true);

console.log('zBrowse contract tests passed');
