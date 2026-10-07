import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function collectIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
    ids.add(match[1]);
  }
  return ids;
}

function collectAttributes(html) {
  const attributes = new Set();
  for (const match of html.matchAll(/\s([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=|\s|>)/g)) {
    attributes.add(match[1].toLowerCase());
  }
  return attributes;
}

function collectStaticDomReferences(source) {
  const ids = new Set();
  const attributes = new Set();

  for (const match of source.matchAll(
    /document\.querySelector(?:All)?\(\s*["']#([A-Za-z][A-Za-z0-9_:.-]*)["']\s*\)/g
  )) {
    ids.add(match[1]);
  }

  for (const match of source.matchAll(
    /\$\(\s*["']([A-Za-z][A-Za-z0-9_:.-]*)["']\s*\)/g
  )) {
    ids.add(match[1]);
  }

  for (const match of source.matchAll(
    /document\.querySelector(?:All)?\(\s*["']\[([A-Za-z_:][A-Za-z0-9_.:-]*)\]["']\s*\)/g
  )) {
    attributes.add(match[1].toLowerCase());
  }

  return { ids, attributes };
}

function auditDomReferences(html, sources) {
  const htmlIds = collectIds(html);
  const htmlAttributes = collectAttributes(html);
  const requiredIds = new Set();
  const requiredAttributes = new Set();

  for (const source of sources) {
    const references = collectStaticDomReferences(source);
    for (const id of references.ids) requiredIds.add(id);
    for (const attribute of references.attributes) requiredAttributes.add(attribute);
  }

  return {
    missingIds: [...requiredIds].filter((id) => !htmlIds.has(id)).sort(),
    missingAttributes: [...requiredAttributes]
      .filter((attribute) => !htmlAttributes.has(attribute))
      .sort(),
  };
}

const targets = [
  {
    label: 'zBrowse portal',
    html: 'zbrowse/gateway/public/index.html',
    scripts: ['zbrowse/gateway/public/app.js'],
  },
  {
    label: 'Chromium popup',
    html: 'chromium/popup.html',
    scripts: ['chromium/popup.js', 'chromium/popup-a11y.js'],
  },
  {
    label: 'Firefox popup',
    html: 'firefox/popup.html',
    scripts: ['firefox/popup.js', 'firefox/popup-a11y.js'],
  },
  {
    label: 'embedded Chromium popup',
    html: 'zbrowse/browser/zguard/popup.html',
    scripts: ['zbrowse/browser/zguard/popup.js', 'zbrowse/browser/zguard/popup-a11y.js'],
  },
];

for (const target of targets) {
  const result = auditDomReferences(
    read(target.html),
    target.scripts.map(read)
  );
  assert.deepEqual(result.missingIds, [], `${target.label}: JS references missing HTML ids`);
  assert.deepEqual(
    result.missingAttributes,
    [],
    `${target.label}: JS references missing HTML selector attributes`
  );
}

assert.deepEqual(
  auditDomReferences(
    '<main id="present"><button data-mode="balanced"></button></main>',
    ['const ok = $("present"); const broken = document.querySelector("#missing"); document.querySelectorAll("[data-role]");']
  ),
  { missingIds: ['missing'], missingAttributes: ['data-role'] },
  'selector-integrity self-test must detect missing id and attribute targets'
);

assert.deepEqual(
  auditDomReferences(
    '<main id="present"><button data-mode="balanced"></button></main>',
    ['const ok = $("present"); document.querySelectorAll("[data-mode]");']
  ),
  { missingIds: [], missingAttributes: [] },
  'selector-integrity self-test must accept matching static selectors'
);

const workflow = read('.github/workflows/ui-dom-selector-integrity.yml');
assert.match(workflow, /runs-on:\s*ubuntu-latest/, 'selector validation must use a portable hosted runner');
assert.match(
  workflow,
  /permissions:\s*\n\s+contents:\s*read/,
  'selector workflow token must remain read-only'
);
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'selector workflow checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /node tests\/ui-dom-selector-integrity\.test\.mjs/,
  'workflow must execute the selector-integrity contract'
);

for (const target of targets) {
  for (const relativePath of [target.html, ...target.scripts]) {
    assert.ok(
      workflow.includes(`- "${relativePath}"`),
      `selector workflow must trigger when ${relativePath} changes`
    );
  }
}

for (const relativePath of [
  'tests/ui-dom-selector-integrity.test.mjs',
  '.github/workflows/ui-dom-selector-integrity.yml',
]) {
  assert.ok(
    workflow.includes(`- "${relativePath}"`),
    `selector workflow must trigger when ${relativePath} changes`
  );
}

console.log('UI DOM selector integrity contract passed');
