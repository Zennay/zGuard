import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0").filter((file) => /\.html$/i.test(file));

function validateFrameBoundary(file, html) {
  const tags = html.replace(/<!--[\s\S]*?-->/g, "").match(/<iframe\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const sandbox = tag.match(/\bsandbox\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!sandbox && file === "zbrowse/gateway/public/index.html" && /\\bid="browserFrame"/.test(tag)) {
      assert.match(tag, /\\btitle="zBrowse browser session"/, "reviewed browser iframe needs an accessible title");
      assert.match(tag, /\\breferrerpolicy="no-referrer"/, "reviewed browser iframe must suppress referrers");
      assert.match(tag, /\\ballow="autoplay; fullscreen"/, "reviewed browser iframe permission boundary changed");
      assert.doesNotMatch(tag, /\\s(?:src|srcdoc)\\s*=/i, "reviewed browser iframe must not load arbitrary static content");
      continue;
    }
    assert.ok(sandbox, `${file}: iframe must declare an explicit sandbox: ${tag}`);
    const tokens = (sandbox[1] ?? sandbox[2] ?? sandbox[3]).trim().toLowerCase().split(/\s+/).filter(Boolean);
    assert.equal(new Set(tokens).size, tokens.length, `${file}: duplicate iframe sandbox permissions`);
    assert.ok(!tokens.includes("allow-top-navigation"), `${file}: unrestricted top navigation forbidden`);
    assert.ok(!tokens.includes("allow-top-navigation-to-custom-protocols"), `${file}: custom protocol navigation forbidden`);
    assert.ok(!(tokens.includes("allow-scripts") && tokens.includes("allow-same-origin")),
      `${file}: allow-scripts with allow-same-origin defeats iframe sandbox isolation`);
  }
}

assert.doesNotThrow(() => validateFrameBoundary("ok", '<iframe title="Preview" sandbox="allow-scripts"></iframe>'));
assert.doesNotThrow(() => validateFrameBoundary("zbrowse/gateway/public/index.html", '<iframe id="browserFrame" title="zBrowse browser session" allow="autoplay; fullscreen" referrerpolicy="no-referrer">'));
assert.throws(() => validateFrameBoundary("zbrowse/gateway/public/index.html", '<iframe id="browserFrame" title="zBrowse browser session" src="https://example.com" allow="autoplay; fullscreen" referrerpolicy="no-referrer">'), /must not load arbitrary/);
assert.throws(() => validateFrameBoundary("missing", '<iframe title="Preview"></iframe>'), /explicit sandbox/);
assert.throws(() => validateFrameBoundary("escape", '<iframe sandbox="allow-scripts allow-same-origin"></iframe>'), /defeats iframe sandbox/);
assert.throws(() => validateFrameBoundary("nav", '<iframe sandbox="allow-top-navigation"></iframe>'), /top navigation forbidden/);
assert.throws(() => validateFrameBoundary("dup", '<iframe sandbox="allow-forms allow-forms"></iframe>'), /duplicate iframe sandbox/);
for (const file of files) {
  validateFrameBoundary(file, fs.readFileSync(path.resolve(file), "utf8"));
}
console.log(`HTML iframe sandbox boundary validated across ${files.length} tracked HTML files`);
