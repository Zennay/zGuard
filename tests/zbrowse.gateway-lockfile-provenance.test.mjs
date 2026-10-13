import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = path.join(root, 'zbrowse', 'gateway');

const pkg = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'package-lock.json'), 'utf8'));
const workflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'gateway-lockfile-provenance.yml'),
  'utf8'
);

assert.equal(lock.lockfileVersion, 3, 'gateway lockfile must remain npm lockfileVersion 3');
assert.equal(lock.requires, true, 'gateway lockfile must retain dependency resolution metadata');

const rootEntry = lock.packages?.[''];
assert.ok(rootEntry, 'gateway lockfile must contain a root package entry');
assert.equal(rootEntry.name, pkg.name, 'package and lockfile root names must match');
assert.equal(rootEntry.version, pkg.version, 'package and lockfile root versions must match');
assert.deepEqual(
  rootEntry.dependencies ?? {},
  pkg.dependencies ?? {},
  'package and lockfile root dependencies must match exactly'
);
assert.deepEqual(
  rootEntry.engines ?? {},
  pkg.engines ?? {},
  'package and lockfile root engine constraints must match exactly'
);

const packages = Object.entries(lock.packages ?? {})
  .filter(([name]) => name.startsWith('node_modules/'))
  .sort(([a], [b]) => a.localeCompare(b));

assert.ok(packages.length > 0, 'gateway lockfile must contain resolved dependencies');

function assertCanonicalSha512Integrity(value, label) {
  assert.equal(typeof value, 'string', `${label} must record Subresource Integrity metadata`);
  assert.match(
    value,
    /^sha512-[A-Za-z0-9+/]+={0,2}$/,
    `${label} must use a sha512 integrity value`
  );

  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  assert.equal(decoded.length, 64, `${label} must encode a full 64-byte SHA-512 digest`);
  assert.equal(
    decoded.toString('base64'),
    encoded,
    `${label} SHA-512 digest must use canonical base64 encoding`
  );
}

const validFixture = 'sha512-' + Buffer.alloc(64, 0x5a).toString('base64');
assert.doesNotThrow(() => assertCanonicalSha512Integrity(validFixture, 'valid fixture'));
for (const malformed of [
  'sha512-YQ==', // valid base64, but only one byte rather than 64
  validFixture.slice(0, -1), // padding dropped; decodes but is noncanonical
  'sha512-' + Buffer.alloc(63, 0x5a).toString('base64'),
  'sha512-$$', 'sha256-' + Buffer.alloc(64).toString('base64')
]) {
  assert.throws(
    () => assertCanonicalSha512Integrity(malformed, 'malformed fixture'),
    /64-byte SHA-512|canonical base64|sha512 integrity/
  );
}

// A valid SRI digest and trusted registry host are insufficient if a lock entry
// resolves a different package or version. Keep the tarball path bound to the
// exact npm package identity, including nested and scoped dependencies.
function assertCanonicalTarballIdentity(resolved, packageKey, version) {
  const marker = 'node_modules/';
  assert.ok(packageKey.includes(marker), 'tarball identity requires a package key');
  const npmPackage = packageKey.slice(packageKey.lastIndexOf(marker) + marker.length);
  const tarballName = npmPackage.split('/').at(-1);
  const expected = `/${npmPackage}/-/${tarballName}-${version}.tgz`;
  assert.equal(
    new URL(resolved).pathname,
    expected,
    `${packageKey}: resolved tarball path must match its npm name and exact version`
  );
}

for (const [name, version, resolved] of [
  ['node_modules/express', '5.1.0', 'https://registry.npmjs.org/express/-/express-5.1.0.tgz'],
  ['node_modules/@grpc/grpc-js', '1.14.5', 'https://registry.npmjs.org/@grpc/grpc-js/-/grpc-js-1.14.5.tgz'],
  [
    'node_modules/@grpc/grpc-js/node_modules/@grpc/proto-loader',
    '0.8.1',
    'https://registry.npmjs.org/@grpc/proto-loader/-/proto-loader-0.8.1.tgz'
  ]
]) {
  assert.doesNotThrow(
    () => assertCanonicalTarballIdentity(resolved, name, version),
    `${name}: valid canonical npm tarball must be accepted`
  );
}

for (const [name, version, resolved] of [
  ['node_modules/express', '5.1.0', 'https://registry.npmjs.org/helmet/-/helmet-5.1.0.tgz'],
  ['node_modules/express', '5.1.0', 'https://registry.npmjs.org/express/-/express-5.1.1.tgz'],
  ['node_modules/@grpc/grpc-js', '1.14.5', 'https://registry.npmjs.org/grpc-js/-/grpc-js-1.14.5.tgz'],
  ['node_modules/express', '5.1.0', 'https://registry.npmjs.org/express/-/different-5.1.0.tgz']
]) {
  assert.throws(
    () => assertCanonicalTarballIdentity(resolved, name, version),
    /resolved tarball path must match/,
    `${name}: mismatched tarball identity must fail closed`
  );
}

for (const [name, entry] of packages) {
  assert.equal(entry.link, undefined, `${name} must not resolve through a local/link dependency`);
  assert.equal(typeof entry.version, 'string', `${name} must record an exact version`);
  assert.match(entry.version, /\S+/, `${name} must record a non-empty exact version`);

  assert.equal(typeof entry.resolved, 'string', `${name} must record its resolved tarball URL`);
  const resolved = new URL(entry.resolved);
  assert.equal(resolved.protocol, 'https:', `${name} must resolve over HTTPS`);
  assert.equal(
    resolved.hostname,
    'registry.npmjs.org',
    `${name} must resolve only from the canonical npm registry`
  );
  assert.equal(resolved.username, '', `${name} resolved URL must not contain credentials`);
  assert.equal(resolved.password, '', `${name} resolved URL must not contain credentials`);
  assert.equal(resolved.search, '', `${name} resolved URL must not contain query parameters`);
  assert.equal(resolved.hash, '', `${name} resolved URL must not contain a fragment`);

  assertCanonicalTarballIdentity(entry.resolved, name, entry.version);

  assertCanonicalSha512Integrity(entry.integrity, name);
}

const approvedInstallScripts = [
  'node_modules/cpu-features@0.0.10',
  'node_modules/protobufjs@7.6.6',
  'node_modules/ssh2@1.17.0'
];

const installScriptPackages = packages
  .filter(([, entry]) => entry.hasInstallScript === true)
  .map(([name, entry]) => `${name}@${entry.version}`)
  .sort();

assert.deepEqual(
  installScriptPackages,
  approvedInstallScripts,
  'gateway dependency lifecycle scripts changed; review the production install-script policy before accepting drift'
);

for (const expected of [
  'repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}',
  'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
  'EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
  'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'
]) {
  assert.ok(
    workflow.includes(expected),
    `gateway lockfile workflow must retain exact-head checkout proof: ${expected}`
  );
}
assert.ok(
  workflow.includes('persist-credentials: false'),
  'gateway lockfile checkout must not persist credentials'
);

console.log(
  `Gateway lockfile provenance passed for ${packages.length} resolved packages; ` +
  `${installScriptPackages.length} reviewed install-script packages`
);
