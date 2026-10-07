import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function dynamicClasses(source) {
  const classes = new Set();

  for (const match of source.matchAll(
    /\.classList\.(?:add|remove|toggle|contains)\(\s*["']([A-Za-z_][A-Za-z0-9_-]*)["']/g
  )) {
    classes.add(match[1]);
  }

  for (const assignment of source.matchAll(/\.className\s*=\s*([^;]+);/g)) {
    for (const literal of assignment[1].matchAll(/["']([^"']+)["']/g)) {
      for (const className of literal[1].split(/\s+/).filter(Boolean)) {
        if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(className)) classes.add(className);
      }
    }
  }

  return [...classes].sort();
}

function cssClasses(source) {
  return new Set(
    [...source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1])
  );
}

function missingStateStyles(jsSources, cssSource) {
  const referenced = new Set(jsSources.flatMap(dynamicClasses));
  const styled = cssClasses(cssSource);
  return [...referenced].filter((className) => !styled.has(className)).sort();
}

const targets = [
  {
    label: 'zBrowse portal',
    scripts: ['zbrowse/gateway/public/app.js'],
    css: 'zbrowse/gateway/public/styles.css',
  },
  {
    label: 'Chromium popup',
    scripts: ['chromium/popup.js', 'chromium/popup-a11y.js'],
    css: 'chromium/popup.css',
  },
  {
    label: 'Firefox popup',
    scripts: ['firefox/popup.js', 'firefox/popup-a11y.js'],
    css: 'firefox/popup.css',
  },
  {
    label: 'embedded Chromium popup',
    scripts: ['zbrowse/browser/zguard/popup.js', 'zbrowse/browser/zguard/popup-a11y.js'],
    css: 'zbrowse/browser/zguard/popup.css',
  },
];

for (const target of targets) {
  const missing = missingStateStyles(target.scripts.map(read), read(target.css));
  assert.deepEqual(
    missing,
    [],
    `${target.label}: JavaScript-managed state classes must retain CSS selectors`
  );
}

assert.deepEqual(
  dynamicClasses(
    'node.classList.toggle("active", enabled); node.classList.contains("busy"); node.className = "status ready";'
  ),
  ['active', 'busy', 'ready', 'status'],
  'state-class parser self-test must discover classList and className literals'
);

assert.deepEqual(
  missingStateStyles(
    ['node.classList.toggle("active"); node.className = "status busy";'],
    '.status { display: block; } .active { font-weight: bold; }'
  ),
  ['busy'],
  'state-style self-test must detect a missing dynamic CSS class'
);

assert.deepEqual(
  missingStateStyles(
    ['node.classList.toggle("active"); node.className = "status busy";'],
    '.status { display: block; } .status.busy { opacity: .5; } button.active { font-weight: bold; }'
  ),
  [],
  'state-style self-test must accept styled dynamic classes'
);

const workflow = read('.github/workflows/ui-state-style-integrity.yml');
assert.match(workflow, /runs-on:\s*ubuntu-latest/, 'state-style validation must use a portable hosted runner');
assert.match(
  workflow,
  /permissions:\s*\n\s+contents:\s*read/,
  'state-style workflow token must remain read-only'
);
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'state-style checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /node tests\/ui-state-style-integrity\.test\.mjs/,
  'workflow must execute the state-style integrity contract'
);

for (const target of targets) {
  for (const relativePath of [...target.scripts, target.css]) {
    assert.ok(
      workflow.includes(`- "${relativePath}"`),
      `state-style workflow must trigger when ${relativePath} changes`
    );
  }
}

for (const relativePath of [
  'tests/ui-state-style-integrity.test.mjs',
  '.github/workflows/ui-state-style-integrity.yml',
]) {
  assert.ok(
    workflow.includes(`- "${relativePath}"`),
    `state-style workflow must trigger when ${relativePath} changes`
  );
}

console.log('UI state-style integrity contract passed');
