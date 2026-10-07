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

function attributes(source) {
  const attrs = new Map();
  for (const match of source.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attrs.set(match[1].toLowerCase(), match[3]);
  }
  return attrs;
}

function resolveLocalAsset(htmlFile, reference) {
  const clean = reference.split(/[?#]/, 1)[0];
  if (clean.startsWith("/")) {
    return path.join(path.dirname(htmlFile), clean.slice(1));
  }
  return path.normalize(path.join(path.dirname(htmlFile), clean));
}

for (const file of htmlFiles) {
  const absolute = path.join(root, file);
  const source = fs.readFileSync(absolute, "utf8");

  assert.match(source, /^<!doctype html>/i, `${file}: must declare an HTML doctype`);
  assert.match(source, /<html\b[^>]*\blang=(["'])[^"']+\1/i, `${file}: html element must declare a language`);
  assert.match(source, /<meta\b[^>]*\bcharset=(["'])?utf-8\1?/i, `${file}: must declare UTF-8`);
  assert.match(source, /<title>[^<]+<\/title>/i, `${file}: must include a non-empty title`);

  assert.doesNotMatch(
    source,
    /\s(on[a-z]+)\s*=\s*(["'])/i,
    `${file}: inline event-handler attributes are forbidden`
  );
  assert.doesNotMatch(
    source,
    /\b(?:href|src|action|formaction)\s*=\s*(["'])\s*javascript:/i,
    `${file}: javascript: URLs are forbidden`
  );

  const ids = [];
  for (const match of source.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)) {
    ids.push(match[2]);
  }
  const seenIds = new Set();
  for (const id of ids) {
    assert.ok(id.trim(), `${file}: id attributes must not be empty`);
    assert.equal(seenIds.has(id), false, `${file}: duplicate id "${id}"`);
    seenIds.add(id);
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

console.log(`HTML resource integrity passed for ${htmlFiles.length} tracked files`);
