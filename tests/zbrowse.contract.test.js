const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));
const filesIn = (relative) => {
  const base = path.join(root, relative);
  const entries = [];
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.join(prefix, name);
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else entries.push([rel, fs.readFileSync(full)]);
    }
  };
  walk(base);
  return entries;
};

const compose = read('zbrowse/docker-compose.yml');
const gatewayDockerfile = read('zbrowse/gateway/Dockerfile');
const browserDockerfile = read('zbrowse/browser/Dockerfile');
const browserStartup = read('zbrowse/browser/root/usr/local/bin/start-zbrowse');
const gatewayServer = read('zbrowse/gateway/server.js');
const gatewayPackage = json('zbrowse/gateway/package.json');
const gatewayLock = json('zbrowse/gateway/package-lock.json');
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

assert.deepEqual(
  gatewayLock.packages?.['']?.dependencies,
  gatewayPackage.dependencies,
  'gateway package-lock root dependencies must exactly match package.json'
);
assert.equal(
  gatewayPackage.dependencies?.['http-proxy-middleware'],
  undefined,
  'vulnerable http-proxy-middleware chain must stay removed'
);
assert.equal(gatewayPackage.dependencies?.httpxy, '^0.5.5');
assert.equal(
  gatewayLock.packages?.['node_modules/httpxy']?.version,
  '0.5.5',
  'gateway lockfile must pin the expected httpxy release'
);
assert.equal(
  gatewayLock.packages?.['node_modules/httpxy']?.integrity,
  'sha512-uDjmnPyp1q4Sgzf3w+J/Fc6UqcCEj0x4Wjp7OqK5dGhNeDgpyrAmnS6ey8QWrX3SWDon2DMKf9sBa5X9+CVyMA==',
  'gateway lockfile must preserve the verified httpxy artifact integrity'
);
for (const removedPackage of [
  'node_modules/http-proxy-middleware',
  'node_modules/@types/http-proxy',
  'node_modules/http-proxy',
  'node_modules/eventemitter3',
  'node_modules/follow-redirects',
  'node_modules/requires-port',
  'node_modules/is-glob',
  'node_modules/is-extglob',
  'node_modules/is-plain-object',
  'node_modules/micromatch',
  'node_modules/braces',
  'node_modules/picomatch',
  'node_modules/fill-range',
  'node_modules/to-regex-range',
  'node_modules/is-number'
]) {
  assert.equal(
    gatewayLock.packages?.[removedPackage],
    undefined,
    `gateway lockfile must not contain removed proxy-chain package: ${removedPackage}`
  );
}

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
  /COPY server\.js config-values\.js request-ip\.js request-path\.js session-admission\.js session-lifetime\.js \.\//,
  'gateway image must include every local runtime module'
);

assert.match(gatewayServer, /import \{ createProxyServer \} from "httpxy";/);
assert.doesNotMatch(gatewayServer, /http-proxy-middleware/);
assert.match(gatewayServer, /browserProxy\.web\(req, res, browserProxyOptions\(req\)\)/);
assert.match(gatewayServer, /browserProxy\.ws\(req, socket, browserProxyOptions\(req\), head\)/);
assert.match(
  gatewayServer,
  /const allowedOrigins = new Set\(sites\.map\(\(site\) => new URL\(site\.url\)\.origin\.toLowerCase\(\)\)\);/,
  'gateway allowlist must be keyed by exact origins'
);
assert.match(
  gatewayServer,
  /!allowedOrigins\.has\(url\.origin\.toLowerCase\(\)\)/,
  'start URLs must reject alternate ports on an otherwise allowed hostname'
);

const createSessionStart = gatewayServer.indexOf('async function createSession');
const destroySessionStart = gatewayServer.indexOf('async function destroySession');
assert.ok(createSessionStart >= 0 && destroySessionStart > createSessionStart, 'gateway must define createSession before destroySession');
const createSessionSource = gatewayServer.slice(createSessionStart, destroySessionStart);
const browserReadyIndex = createSessionSource.indexOf('await waitForBrowser(containerName, subfolder)');
const sessionPublishIndex = createSessionSource.indexOf('sessions.set(token, session)');
const ipPublishIndex = createSessionSource.indexOf('sessionsByIp.set(ip, token)');
assert.ok(browserReadyIndex >= 0, 'session creation must wait for browser readiness');
assert.ok(
  sessionPublishIndex > browserReadyIndex && ipPublishIndex > browserReadyIndex,
  'session tokens and IP ownership must not be published before browser readiness'
);
assert.match(
  createSessionSource,
  /catch \(error\) \{\s*await stopContainer\(container\);\s*throw error;/,
  'failed starts must clean up the unpublished container directly'
);

assert.match(browserDockerfile, /COPY zguard \/opt\/zguard/);
assert.match(browserDockerfile, /COPY policies\/policy\.json \/etc\/chromium\/policies\/managed\/zbrowse-policy\.json/);
assert.match(browserDockerfile, /COPY root \/$/m);
assert.match(browserStartup, /--disable-extensions-except=\/opt\/zguard/);
assert.match(browserStartup, /--load-extension=\/opt\/zguard/);
assert.match(browserStartup, /--user-data-dir=\/config\/chromium/);
assert.match(browserStartup, /--disk-cache-dir=\/config\/tmp/);

const apiFallbackIndex = gatewayServer.indexOf('app.use("/api"');
const staticIndex = gatewayServer.indexOf('app.use(express.static');
assert.ok(apiFallbackIndex >= 0, 'gateway must define an API 404 fallback');
assert.ok(staticIndex > apiFallbackIndex, 'API 404 fallback must run before SPA static fallback');
assert.match(gatewayServer, /status\(404\)\.json\(\{ error: "API route not found\." \}\)/);

assert.ok(Array.isArray(sites) && sites.length > 0, 'at least one site must be configured');
const seenOrigins = new Set();
for (const site of sites) {
  assert.equal(typeof site.name, 'string');
  const url = new URL(site.url);
  assert.equal(url.protocol, 'https:', `${site.name}: only HTTPS sites are allowed`);
  assert.ok(!seenOrigins.has(url.origin), `${site.name}: duplicate origin`);
  seenOrigins.add(url.origin);
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
  sites.some((site) => new URL(site.url).origin === new URL(envStart).origin),
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

const canonicalZguard = filesIn('chromium');
const bundledZguard = filesIn('zbrowse/browser/zguard');
assert.deepEqual(
  bundledZguard.map(([name]) => name),
  canonicalZguard.map(([name]) => name),
  'zBrowse must bundle the complete Chromium zGuard package'
);
for (let index = 0; index < canonicalZguard.length; index += 1) {
  assert.equal(
    Buffer.compare(bundledZguard[index][1], canonicalZguard[index][1]),
    0,
    `zBrowse bundled zGuard file drifted: ${canonicalZguard[index][0]}`
  );
}

console.log('zBrowse contract tests passed');
