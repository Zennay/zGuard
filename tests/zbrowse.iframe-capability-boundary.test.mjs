import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portalPath = "zbrowse/gateway/public/index.html";

function attributes(tagSource) {
  const opening = tagSource.match(/^<[a-z][\w:-]*\b/i);
  assert.ok(opening, `opening tag could not be parsed: ${tagSource}`);

  const body = tagSource.slice(opening[0].length).replace(/\/?>$/, "");
  const attrs = new Map();
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;

  for (const match of body.matchAll(pattern)) {
    attrs.set(
      match[1].toLowerCase(),
      match[2] ?? match[3] ?? match[4] ?? ""
    );
  }
  return attrs;
}

function assertBrowserFrameBoundary(source, label) {
  const browserFrames = [];

  for (const match of source.matchAll(/<iframe\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.get("id") === "browserFrame") {
      browserFrames.push(attrs);
    }
  }

  assert.equal(
    browserFrames.length,
    1,
    `${label}: must contain exactly one browserFrame iframe`
  );

  const attrs = browserFrames[0];

  assert.equal(
    attrs.has("src"),
    false,
    `${label}: browserFrame must not load a static source before an authorized session exists`
  );
  assert.equal(
    attrs.has("srcdoc"),
    false,
    `${label}: browserFrame must not embed active srcdoc markup`
  );
  assert.equal(
    (attrs.get("referrerpolicy") ?? "").trim().toLowerCase(),
    "no-referrer",
    `${label}: browserFrame must suppress referrer disclosure`
  );
  assert.equal(
    attrs.has("allowfullscreen"),
    false,
    `${label}: browserFrame must use the reviewed Permissions Policy allow list instead of legacy allowfullscreen`
  );

  const allowedFeatures = (attrs.get("allow") ?? "")
    .split(";")
    .map((feature) => feature.trim().toLowerCase())
    .filter(Boolean)
    .sort();

  assert.deepEqual(
    allowedFeatures,
    ["autoplay", "fullscreen"],
    `${label}: browserFrame capabilities must remain limited to autoplay and fullscreen`
  );
}

assert.doesNotThrow(() =>
  assertBrowserFrameBoundary(
    '<iframe id="browserFrame" title="Browser" allow="fullscreen; autoplay" referrerpolicy="no-referrer"></iframe>',
    "self-test valid"
  )
);

assert.throws(
  () =>
    assertBrowserFrameBoundary(
      '<iframe id="browserFrame" allow="autoplay; fullscreen; camera" referrerpolicy="no-referrer"></iframe>',
      "self-test camera"
    ),
  /capabilities must remain limited/
);

assert.throws(
  () =>
    assertBrowserFrameBoundary(
      '<iframe id="browserFrame" src="/session/preload" allow="autoplay; fullscreen" referrerpolicy="no-referrer"></iframe>',
      "self-test static src"
    ),
  /must not load a static source/
);

assert.throws(
  () =>
    assertBrowserFrameBoundary(
      '<iframe id="browserFrame" allow="autoplay; fullscreen" referrerpolicy="origin"></iframe>',
      "self-test referrer"
    ),
  /must suppress referrer disclosure/
);

assert.throws(
  () =>
    assertBrowserFrameBoundary(
      '<iframe id="browserFrame" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer"></iframe>',
      "self-test legacy fullscreen"
    ),
  /legacy allowfullscreen/
);

const portal = fs.readFileSync(path.join(root, portalPath), "utf8");
assertBrowserFrameBoundary(portal, portalPath);

console.log("zBrowse iframe capability boundary contract passed");
