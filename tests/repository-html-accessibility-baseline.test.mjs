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

function textContent(fragment) {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAriaName(attrs) {
  return Boolean(
    attrs.get("aria-label")?.trim() ||
    attrs.get("aria-labelledby")?.trim()
  );
}

function hasNativeButtonName(attrs) {
  const type = (attrs.get("type") || "text").toLowerCase();
  if (type === "image") return Boolean(attrs.get("alt")?.trim());
  if (["button", "submit", "reset"].includes(type)) {
    return Boolean(attrs.get("value")?.trim());
  }
  return false;
}

function validateHtmlAccessibility(file, source) {
  const labelForIds = new Set();
  const wrappedControlIds = new Set();

  for (const label of source.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const labelAttrs = attributes(`<label${label[1]}>`);
    const forId = labelAttrs.get("for")?.trim();
    if (forId) labelForIds.add(forId);

    for (const control of label[2].matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
      const controlAttrs = attributes(control[0]);
      const id = controlAttrs.get("id")?.trim();
      if (id) wrappedControlIds.add(id);
    }
  }

  for (const tag of source.matchAll(/<[a-z][^>]*>/gi)) {
    const name = tag[0].match(/^<([a-z][\w:-]*)/i)?.[1]?.toLowerCase();
    const attrs = attributes(tag[0]);

    if (attrs.has("tabindex")) {
      const raw = attrs.get("tabindex").trim();
      assert.match(raw, /^-?\d+$/, `${file}: tabindex must be an integer in ${tag[0]}`);
      assert.ok(
        Number(raw) <= 0,
        `${file}: positive tabindex creates a brittle keyboard order in ${tag[0]}`
      );
    }

    const isInteractive =
      name === "button" ||
      name === "input" ||
      name === "select" ||
      name === "textarea" ||
      (name === "a" && attrs.has("href"));

    if (isInteractive) {
      assert.notEqual(
        attrs.get("aria-hidden")?.toLowerCase(),
        "true",
        `${file}: interactive control must not be hidden from assistive technology: ${tag[0]}`
      );
    }

    if (name === "iframe") {
      assert.ok(
        attrs.get("title")?.trim(),
        `${file}: iframe must have a non-empty title`
      );
    }
  }

  for (const button of source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = attributes(`<button${button[1]}>`);
    assert.ok(
      hasAriaName(attrs) || textContent(button[2]),
      `${file}: button must have visible text or an ARIA accessible name`
    );
  }

  for (const anchor of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(`<a${anchor[1]}>`);
    if (!attrs.has("href")) continue;

    assert.ok(
      hasAriaName(attrs) || textContent(anchor[2]),
      `${file}: link with href must have visible text or an ARIA accessible name`
    );
  }

  for (const control of source.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const kind = control[1].toLowerCase();
    const attrs = attributes(control[0]);
    const type = (attrs.get("type") || "text").toLowerCase();

    if (kind === "input" && type === "hidden") continue;

    const id = attrs.get("id")?.trim();
    const labelled =
      hasAriaName(attrs) ||
      hasNativeButtonName(attrs) ||
      (id && (labelForIds.has(id) || wrappedControlIds.has(id)));

    assert.ok(
      labelled,
      `${file}: ${kind} control must have an accessible label/name: ${control[0]}`
    );
  }
}

const validFixture = `
<!doctype html><html lang="en"><head><title>x</title></head><body>
<label for="name">Name</label><input id="name">
<label><span>Enabled</span><input id="enabled" type="checkbox"></label>
<button type="button">Save</button>
<a href="/">Home</a>
<iframe title="Preview"></iframe>
</body></html>`;
assert.doesNotThrow(() => validateHtmlAccessibility("self-test-valid.html", validFixture));
assert.throws(
  () => validateHtmlAccessibility("self-test-input.html", "<input id=\"orphan\">"),
  /accessible label\/name/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-button.html", "<button type=\"button\"></button>"),
  /button must have/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-iframe.html", "<iframe></iframe>"),
  /non-empty title/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-tabindex.html", "<button tabindex=\"2\">Go</button>"),
  /positive tabindex/
);
assert.throws(
  () => validateHtmlAccessibility("self-test-hidden.html", "<button aria-hidden=\"true\">Go</button>"),
  /must not be hidden/
);

for (const file of htmlFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  validateHtmlAccessibility(file, source);
}

console.log(`HTML accessibility baseline passed for ${htmlFiles.length} tracked files`);
