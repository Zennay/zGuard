import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertVpsOwnerGuardedJob } from "../tools/workflow-runner-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root, encoding: "utf8"
}).split("\0").filter(Boolean);
const trackedSet = new Set(tracked);
const htmlFiles = tracked.filter((name) => path.extname(name).toLowerCase() === ".html").sort();
for (const required of [
  "chromium/popup.html", "firefox/popup.html",
  "zbrowse/browser/zguard/popup.html", "zbrowse/gateway/public/index.html"
]) {
  assert.ok(htmlFiles.includes(required), "Missing HTML coverage: " + required);
}

function attributes(tag) {
  const open = /^<[a-z][\w:-]*\b/i.exec(tag);
  assert.ok(open, "Expected opening HTML tag");
  const body = tag.slice(open[0].length).replace(/\/?>$/, "");
  const map = new Map();
  for (const match of body.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g)) {
    map.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return map;
}

function localResource(file, tag, attribute, value, existing) {
  assert.ok(value.trim(), file + ": " + tag + " " + attribute + " cannot be empty");
  // Fail closed on encoded resource URLs rather than trying to emulate
  // HTML entity and URL decoding in a repository scanner.
  assert.doesNotMatch(value, /[\\%&\u0000-\u0020\u007f]/,
    file + ": encoded, whitespace or control chars in " + attribute);
  assert.doesNotMatch(value, /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i,
    file + ": external/active " + attribute + " URL is forbidden");
  assert.doesNotMatch(value, /(^|\/)\.\.(\/|$)/,
    file + ": traversal in " + attribute + " URL is forbidden");
  if (value.startsWith("#") && ["use", "image", "feimage"].includes(tag)) return;

  const base = path.posix.dirname(file);
  const resolved = path.posix.normalize(path.posix.join(base, value.replace(/^\/+/, "").split(/[?#]/, 1)[0]));
  assert.ok(existing.has(resolved),
    file + ": " + tag + " " + attribute + " must resolve to a tracked local asset: " + value);
}

function validate(file, html, existing) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const found of withoutComments.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const tag = found[1].toLowerCase();
    const attrs = attributes(found[0]);
    assert.equal(attrs.has("srcset"), false,
      file + ": srcset introduces unreviewed image candidates");

    for (const attribute of ["src", "poster", "background"]) {
      if (attrs.has(attribute) && tag !== "iframe") {
        localResource(file, tag, attribute, attrs.get(attribute), existing);
      }
    }
    if (tag === "object" && attrs.has("data")) {
      localResource(file, tag, "data", attrs.get("data"), existing);
    }
    if (["use", "image", "feimage"].includes(tag)) {
      for (const name of ["href", "xlink:href"]) {
        if (attrs.has(name)) localResource(file, tag, name, attrs.get(name), existing);
      }
    }
    if (tag === "link") {
      const rel = (attrs.get("rel") ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      assert.deepEqual(rel, ["stylesheet"], file + ": unreviewed link preload/hint/resource rel");
      assert.ok(attrs.has("href"), file + ": stylesheet must declare local href");
      localResource(file, tag, "href", attrs.get("href"), existing);
    }
  }
}

const assets = new Set(["fixtures/logo.svg", "fixtures/clip.mp4", "fixtures/portal.css"]);
for (const safe of [
  '<img src="logo.svg">',
  '<video poster="logo.svg"><source src="clip.mp4"></video>',
  '<link rel="stylesheet" href="portal.css">',
  '<span title="https://example.test/"></span>',
  '<!-- <img src="https://example.test/"> -->'
]) {
  assert.doesNotThrow(() => validate("fixtures/page.html", safe, assets), safe);
}
for (const [title, html] of [
  ["remote img", '<img src="https://collector.example/track">'],
  ["protocol-relative img", '<img src="//collector.example/track">'],
  ["backslash URL", '<img src="/\\collector.example/track">'],
  ["HTML entity URL", '<img src="https&#58;//collector.example/track">'],
  ["percent obfuscation", '<img src="%2f%2fcollector.example/track">'],
  ["data script", '<script src="data:text/javascript,alert(1)"></script>'],
  ["blob media", '<video poster="blob:abc"></video>'],
  ["remote object", '<object data="https://collector.example/object"></object>'],
  ["remote SVG", '<svg><image xlink:href="https://collector.example/pixel"></image></svg>'],
  ["srcset", '<img srcset="https://collector.example/x 1x">'],
  ["dns prefetch", '<link rel="dns-prefetch" href="//collector.example">'],
  ["preconnect", '<link rel="preconnect" href="https://collector.example">'],
  ["untracked", '<img src="missing.png">'],
  ["traversal", '<img src="../logo.svg">']
]) {
  assert.throws(() => validate("fixtures/page.html", html, assets),
    /forbidden|encoded|traversal|tracked|unreviewed/, title);
}

for (const file of htmlFiles) {
  validate(file, fs.readFileSync(path.join(root, file), "utf8"), trackedSet);
}
const workflow = fs.readFileSync(path.join(root,
  ".github/workflows/repository-html-passive-resource-privacy.yml"), "utf8");
for (const expected of [
  "pull_request:", "push:", "workflow_dispatch:",
  "timeout-minutes: 5", "contents: read",
  "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
  "persist-credentials: false", "git rev-parse HEAD", "EXPECTED_SHA:",
  "node tests/repository-html-passive-resource-privacy.test.mjs"
]) {
  assert.ok(workflow.includes(expected), "HTML passive resource CI missing " + expected);
}
assertVpsOwnerGuardedJob(workflow, "HTML passive resource CI");
assert.doesNotMatch(workflow, /^\s+paths:\s*$/m, "Always-on HTML privacy CI must not have path filters");
console.log("HTML passive resource privacy passed for " + htmlFiles.length + " tracked documents");
