const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function localAsset(browserDir, asset, label) {
  assert.equal(typeof asset, 'string', `${label}: asset path must be a string`);
  assert.ok(asset.length > 0, `${label}: asset path must not be empty`);
  assert.ok(!asset.includes('://'), `${label}: remote asset URLs are not allowed (${asset})`);
  assert.ok(!path.isAbsolute(asset), `${label}: absolute asset paths are not allowed (${asset})`);

  const base = path.resolve(root, browserDir);
  const resolved = path.resolve(base, asset);
  assert.ok(
    resolved === base || resolved.startsWith(base + path.sep),
    `${label}: asset escapes browser package (${asset})`
  );
  assert.ok(fs.existsSync(resolved), `${label}: missing asset ${asset}`);
}

function htmlAssets(browserDir, popupPath) {
  const html = fs.readFileSync(path.join(root, browserDir, popupPath), 'utf8');
  const assets = [];
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)];

  assert.ok(scriptTags.length > 0, `${browserDir}: popup must load at least one script`);
  for (const tag of scriptTags) {
    assert.match(
      tag[1],
      /\bsrc=["'][^"']+["']/i,
      `${browserDir}: inline popup scripts are not allowed`
    );
  }
  assert.ok(
    !/\son[a-z]+\s*=/i.test(html),
    `${browserDir}: inline HTML event handlers are not allowed`
  );

  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    assets.push({ kind: 'script', path: match[1] });
  }
  for (const match of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    assets.push({ kind: 'link', path: match[1] });
  }

  assert.ok(assets.length >= 2, `${browserDir}: popup must reference its local JS and CSS assets`);
  for (const asset of assets) {
    localAsset(browserDir, asset.path, `${browserDir} popup ${asset.kind}`);
  }
}

function validateExtensionVersion(browserDir, version) {
  assert.equal(typeof version, 'string', `${browserDir}: extension version must be a string`);
  assert.match(
    version,
    /^(?:0|[1-9][0-9]*)(?:[.](?:0|[1-9][0-9]*)){0,3}$/,
    `${browserDir}: invalid extension version format (${version})`
  );

  const parts = version.split('.').map(Number);
  assert.ok(
    parts.every((part) => part <= 65535),
    `${browserDir}: extension version segments must be <= 65535 (${version})`
  );
  assert.ok(
    parts.some((part) => part !== 0),
    `${browserDir}: extension version must not be all zero (${version})`
  );
}

function validateManifest(browserDir, manifest, expectedVersion) {
  assert.equal(manifest.manifest_version, expectedVersion, `${browserDir}: unexpected manifest version`);
  assert.ok(manifest.name, `${browserDir}: missing extension name`);
  validateExtensionVersion(browserDir, manifest.version);
  assert.ok(manifest.description, `${browserDir}: missing extension description`);

  const action = manifest.action || manifest.browser_action;
  assert.ok(action, `${browserDir}: missing toolbar action`);
  assert.ok(action.default_title, `${browserDir}: missing toolbar title`);
  assert.ok(action.default_popup, `${browserDir}: missing popup entrypoint`);
  localAsset(browserDir, action.default_popup, `${browserDir} default popup`);
  htmlAssets(browserDir, action.default_popup);

  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0,
    `${browserDir}: missing content scripts`);

  let hasDocumentStartAllFrames = false;
  for (const [index, entry] of manifest.content_scripts.entries()) {
    assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0,
      `${browserDir}: content script #${index + 1} has no match patterns`);

    for (const asset of entry.js || []) {
      localAsset(browserDir, asset, `${browserDir} content script #${index + 1}`);
    }
    for (const asset of entry.css || []) {
      localAsset(browserDir, asset, `${browserDir} content stylesheet #${index + 1}`);
    }

    if (entry.run_at === 'document_start' && entry.all_frames === true) {
      hasDocumentStartAllFrames = true;
    }
  }
  assert.ok(hasDocumentStartAllFrames,
    `${browserDir}: popup protection must keep at least one document_start all-frames content script`);

  if (expectedVersion === 3) {
    assert.ok(manifest.background?.service_worker, `${browserDir}: missing MV3 service worker`);
    localAsset(browserDir, manifest.background.service_worker, `${browserDir} service worker`);
  } else {
    assert.ok(Array.isArray(manifest.background?.scripts) && manifest.background.scripts.length > 0,
      `${browserDir}: missing MV2 background scripts`);
    for (const asset of manifest.background.scripts) {
      localAsset(browserDir, asset, `${browserDir} background script`);
    }
  }
}

for (const version of ['1', '1.0', '2.10.2', '3.1.2.4567', '0.2', '65535.0']) {
  validateExtensionVersion('fixture', version);
}
for (const version of ['', '01.2', '1.02', '1.0.0-beta', '1.2.3.4.5', '65536', '0.0.0']) {
  assert.throws(
    () => validateExtensionVersion('fixture', version),
    undefined,
    `invalid extension version unexpectedly accepted: ${version}`
  );
}

const chromium = readJson('chromium/manifest.json');
const firefox = readJson('firefox/manifest.json');

validateManifest('chromium', chromium, 3);
validateManifest('firefox', firefox, 2);

for (const key of ['name', 'version', 'description']) {
  assert.equal(chromium[key], firefox[key], `cross-browser metadata drift: ${key}`);
}

assert.equal(
  chromium.action.default_title,
  firefox.browser_action.default_title,
  'cross-browser toolbar title drift'
);
assert.equal(
  chromium.action.default_popup,
  firefox.browser_action.default_popup,
  'cross-browser popup entrypoint drift'
);

console.log('zGuard manifest and popup asset integrity passed');
