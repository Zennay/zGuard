import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8"
}).split("\0").filter(Boolean);

const htmlFiles = tracked.filter((file) => file.endsWith(".html")).sort();
assert.ok(htmlFiles.length > 0, "repository must contain tracked HTML files");

const singleIdRefAttributes = new Set([
  "aria-activedescendant",
  "aria-details",
  "aria-errormessage",
  "for",
  "form",
  "list"
]);
const multiIdRefAttributes = new Set([
  "aria-controls",
  "aria-describedby",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
  "headers"
]);

function attributes(source) {
  const body = source
    .replace(/^<[a-z][\w:-]*\b/i, "")
    .replace(/\/?>$/, "");
  const attrs = new Map();
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;

  for (const match of body.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs.set(name, value);
  }
  return attrs;
}

const attributeParserSelfTest = attributes(
  '<input id=sample aria-describedby=hint disabled data-label="quoted" title=\'single\'>'
);
assert.equal(attributeParserSelfTest.get("id"), "sample");
assert.equal(attributeParserSelfTest.get("aria-describedby"), "hint");
assert.equal(attributeParserSelfTest.get("disabled"), "");
assert.equal(attributeParserSelfTest.get("data-label"), "quoted");
assert.equal(attributeParserSelfTest.get("title"), "single");

function assertNoDuplicateAttributes(file, tagSource) {
  const tag = tagSource.match(/^<([a-z][\w:-]*)\b/i);
  assert.ok(tag, `${file}: opening tag could not be parsed: ${tagSource}`);

  const attributeSource = tagSource.slice(tag[0].length).replace(/\/?>$/, "");
  const seen = new Set();
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?/g;

  for (const match of attributeSource.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    assert.equal(
      seen.has(name),
      false,
      `${file}: duplicate HTML attribute "${name}" in ${tagSource}`
    );
    seen.add(name);
  }
}

assert.doesNotThrow(() => assertNoDuplicateAttributes("self-test", '<input id="a" hidden>'));
assert.throws(
  () => assertNoDuplicateAttributes("self-test", '<input id="a" ID="b">'),
  /duplicate HTML attribute "id"/
);

function assertSafeInlineAttributes(file, tagSource) {
  const attrs = attributes(tagSource);

  for (const name of attrs.keys()) {
    assert.doesNotMatch(
      name,
      /^on[a-z]+$/i,
      `${file}: inline event-handler attributes are forbidden in ${tagSource}`
    );
  }

  assert.equal(
    attrs.has("style"),
    false,
    `${file}: inline style attributes are forbidden; use a local stylesheet`
  );

  for (const attribute of ["href", "src", "action", "formaction"]) {
    const value = attrs.get(attribute);
    if (value === undefined) continue;
    assert.doesNotMatch(
      value.trim(),
      /^javascript:/i,
      `${file}: javascript: URLs are forbidden in ${attribute}`
    );
  }
}

assert.doesNotThrow(() =>
  assertSafeInlineAttributes("self-test", '<a href="/safe" data-action="open">Safe</a>')
);
assert.throws(
  () => assertSafeInlineAttributes("self-test", "<button onclick=alert(1)>"),
  /inline event-handler attributes are forbidden/
);
assert.throws(
  () => assertSafeInlineAttributes("self-test", "<div STYLE=color:red>"),
  /inline style attributes are forbidden/
);
assert.throws(
  () => assertSafeInlineAttributes("self-test", "<a href=javascript:alert(1)>"),
  /javascript: URLs are forbidden/
);

function assertDocumentMetadataContract(file, source) {
  const doctypes = [...source.matchAll(/<!doctype\s+html\s*>/gi)];
  assert.equal(doctypes.length, 1, `${file}: must declare exactly one HTML doctype`);

  const htmlTags = [...source.matchAll(/<html\b[^>]*>/gi)];
  assert.equal(htmlTags.length, 1, `${file}: must declare exactly one html root element`);
  const htmlAttrs = attributes(htmlTags[0][0]);
  const language = htmlAttrs.get("lang")?.trim();
  assert.ok(
    language,
    `${file}: html element must declare a non-empty language`
  );
  assert.doesNotThrow(
    () => Intl.getCanonicalLocales(language),
    `${file}: html lang must be a valid BCP 47 language tag`
  );

  const charsetMetas = [];
  for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.has("charset")) charsetMetas.push(attrs);
  }
  assert.equal(
    charsetMetas.length,
    1,
    `${file}: must declare exactly one charset meta tag`
  );
  assert.equal(
    charsetMetas[0].get("charset")?.toLowerCase(),
    "utf-8",
    `${file}: charset must be UTF-8`
  );

  const titles = [...source.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
  assert.equal(titles.length, 1, `${file}: must declare exactly one title`);
  assert.ok(titles[0][1].trim(), `${file}: title must not be empty`);
}

assert.doesNotThrow(() =>
  assertDocumentMetadataContract(
    "self-test",
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title></head></html>'
  )
);
assert.throws(
  () =>
    assertDocumentMetadataContract(
      "self-test",
      '<!doctype html><!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title></head></html>'
    ),
  /exactly one HTML doctype/
);
assert.throws(
  () =>
    assertDocumentMetadataContract(
      "self-test",
      '<!doctype html><html lang=""><head><meta charset="utf-8"><title>Example</title></head></html>'
    ),
  /non-empty language/
);
assert.throws(
  () =>
    assertDocumentMetadataContract(
      "self-test",
      '<!doctype html><html lang="en_US"><head><meta charset="utf-8"><title>Example</title></head></html>'
    ),
  /valid BCP 47 language tag/
);
assert.throws(
  () =>
    assertDocumentMetadataContract(
      "self-test",
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta charset="windows-1252"><title>Example</title></head></html>'
    ),
  /exactly one charset meta tag/
);
assert.throws(
  () =>
    assertDocumentMetadataContract(
      "self-test",
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>One</title><title>Two</title></head></html>'
    ),
  /exactly one title/
);

function assertViewportContract(file, source) {
  const viewportMetas = [];

  for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if ((attrs.get("name") ?? "").toLowerCase() === "viewport") {
      viewportMetas.push(attrs);
    }
  }

  assert.equal(
    viewportMetas.length,
    1,
    `${file}: must declare exactly one viewport meta tag`
  );

  const content = (viewportMetas[0].get("content") ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const directives = new Map();
  for (const part of content) {
    const [name, ...rest] = part.split("=");
    const key = name.trim();
    assert.equal(
      directives.has(key),
      false,
      `${file}: viewport directive "${key}" must not be duplicated`
    );
    directives.set(key, rest.join("=").trim());
  }

  assert.equal(
    directives.get("width"),
    "device-width",
    `${file}: viewport width must be device-width`
  );
  assert.equal(
    directives.get("initial-scale"),
    "1",
    `${file}: viewport initial-scale must be 1`
  );
  assert.ok(
    !["no", "0"].includes(directives.get("user-scalable")),
    `${file}: viewport must not disable user zoom`
  );
}

assert.doesNotThrow(() =>
  assertViewportContract(
    "self-test",
    '<meta content="initial-scale=1, width=device-width" name="viewport">'
  )
);
assert.throws(
  () => assertViewportContract("self-test", '<meta name="viewport" content="width=640,initial-scale=1">'),
  /viewport width must be device-width/
);
assert.throws(
  () =>
    assertViewportContract(
      "self-test",
      '<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">'
    ),
  /must not disable user zoom/
);
assert.throws(
  () =>
    assertViewportContract(
      "self-test",
      '<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=0">'
    ),
  /must not disable user zoom/
);
assert.throws(
  () =>
    assertViewportContract(
      "self-test",
      '<meta name="viewport" content="width=device-width,width=device-width,initial-scale=1">'
    ),
  /viewport directive "width" must not be duplicated/
);

function resolveLocalAsset(htmlFile, reference) {
  const clean = reference.split(/[?#]/, 1)[0];
  if (clean.startsWith("/")) {
    return path.join(path.dirname(htmlFile), clean.slice(1));
  }
  return path.normalize(path.join(path.dirname(htmlFile), clean));
}

function assertIdRef(file, attribute, value, seenIds, multiple) {
  const references = multiple
    ? value.trim().split(/\s+/).filter(Boolean)
    : [value.trim()].filter(Boolean);

  assert.ok(
    references.length > 0,
    `${file}: ${attribute} must reference at least one non-empty id`
  );

  for (const reference of references) {
    assert.ok(
      seenIds.has(reference),
      `${file}: ${attribute} references missing id "${reference}"`
    );
  }
}

for (const file of htmlFiles) {
  const absolute = path.join(root, file);
  const source = fs.readFileSync(absolute, "utf8");

  assertDocumentMetadataContract(file, source);
  assertViewportContract(file, source);

  assert.doesNotMatch(
    source,
    /\s(on[a-z]+)\s*=\s*(["'])/i,
    `${file}: inline event-handler attributes are forbidden`
  );
  assert.doesNotMatch(
    source,
    /\sstyle\s*=\s*(["'])/i,
    `${file}: inline style attributes are forbidden; use a local stylesheet`
  );
  assert.doesNotMatch(
    source,
    /<style\b[^>]*>[\s\S]*?<\/style>/i,
    `${file}: inline style blocks are forbidden; use a local stylesheet`
  );
  assert.doesNotMatch(
    source,
    /\b(?:href|src|action|formaction)\s*=\s*(["'])\s*javascript:/i,
    `${file}: javascript: URLs are forbidden`
  );

  const ids = [];
  for (const match of source.matchAll(/<[a-z][^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.has("id")) ids.push(attrs.get("id"));
  }
  const seenIds = new Set();
  for (const id of ids) {
    assert.ok(id.trim(), `${file}: id attributes must not be empty`);
    assert.equal(seenIds.has(id), false, `${file}: duplicate id "${id}"`);
    seenIds.add(id);
  }

  for (const match of source.matchAll(/<[a-z][^>]*>/gi)) {
    assertNoDuplicateAttributes(file, match[0]);
    assertSafeInlineAttributes(file, match[0]);
    const attrs = attributes(match[0]);

    for (const attribute of singleIdRefAttributes) {
      if (attrs.has(attribute)) {
        assertIdRef(file, attribute, attrs.get(attribute), seenIds, false);
      }
    }

    for (const attribute of multiIdRefAttributes) {
      if (attrs.has(attribute)) {
        assertIdRef(file, attribute, attrs.get(attribute), seenIds, true);
      }
    }

    const href = attrs.get("href");
    if (href?.startsWith("#")) {
      assertIdRef(file, "href fragment", href.slice(1), seenIds, false);
    }
  }

  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = attributes(match[1]);
    const src = attrs.get("src");
    assert.ok(src, `${file}: inline script blocks are forbidden; use a local src`);
    assert.equal(match[2].trim(), "", `${file}: script tags with src must not contain inline code`);
    assert.doesNotMatch(src, /^(?:https?:)?\/\//i, `${file}: remote scripts are forbidden`);
    const resolved = resolveLocalAsset(file, src);
    assert.ok(tracked.includes(resolved), `${file}: referenced script is not tracked: ${src}`);
  }

  for (const match of source.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;

    const href = attrs.get("href");
    assert.ok(href, `${file}: stylesheet links must include href`);
    assert.doesNotMatch(href, /^(?:https?:)?\/\//i, `${file}: remote stylesheets are forbidden`);
    const resolved = resolveLocalAsset(file, href);
    assert.ok(tracked.includes(resolved), `${file}: referenced stylesheet is not tracked: ${href}`);
  }
}

console.log(
  `HTML resource, attribute, and ID-reference integrity passed for ${htmlFiles.length} tracked files`
);
