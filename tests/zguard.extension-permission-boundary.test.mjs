import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertVpsOwnerGuardedJob } from "../tools/workflow-runner-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (location) => JSON.parse(fs.readFileSync(path.join(root, location), "utf8"));
const chromium = load("chromium/manifest.json");
const firefox = load("firefox/manifest.json");
const bundled = load("zbrowse/browser/zguard/manifest.json");

const forbiddenSurfaces = [
  "optional_permissions", "optional_host_permissions", "web_accessible_resources",
  "externally_connectable", "external_connectable", "update_url", "oauth2",
  "devtools_page", "commands", "omnibox", "chrome_url_overrides",
  "chrome_settings_overrides", "options_page", "options_ui",
  "content_security_policy", "sandbox"
];

function asSortedSet(input, label) {
  assert.ok(Array.isArray(input), label + " must be an explicit array");
  assert.equal(new Set(input).size, input.length, label + " must not duplicate grants");
  assert.ok(input.every((item) => typeof item === "string"), label + " strings only");
  return [...input].sort();
}

function validate(manifest, browser) {
  const chromiumVariant = browser !== "firefox";
  const label = browser + " manifest";
  assert.equal(manifest.manifest_version, chromiumVariant ? 3 : 2,
    label + ": manifest version changed unexpectedly");

  const requiredPermissions = chromiumVariant
    ? ["storage", "tabs"] : ["<all_urls>", "storage", "tabs"];
  assert.deepEqual(asSortedSet(manifest.permissions, label + " permissions"),
    requiredPermissions.sort(), label + ": additional API permissions require review");
  if (chromiumVariant) {
    assert.deepEqual(asSortedSet(manifest.host_permissions, label + " host permissions"),
      ["<all_urls>"], label + ": host permissions drifted");
  } else {
    assert.equal(manifest.host_permissions, undefined,
      label + ": MV2 hosts belong in reviewed permissions only");
  }

  for (const key of forbiddenSurfaces) {
    assert.equal(Object.hasOwn(manifest, key), false,
      label + ": unreviewed manifest capability " + key + " is forbidden");
  }

  assert.ok(Array.isArray(manifest.content_scripts), label + ": content_scripts required");
  assert.equal(manifest.content_scripts.length, chromiumVariant ? 2 : 1,
    label + ": only the reviewed privileged and optional MAIN-world entries are allowed");
  if (chromiumVariant) {
    const page = manifest.content_scripts[0];
    assert.deepEqual(asSortedSet(page.matches, label + " MAIN matches"), ["<all_urls>"]);
    assert.deepEqual(asSortedSet(page.js, label + " MAIN scripts"), ["page-interceptor.js"]);
    assert.equal(page.world, "MAIN", label + ": page interceptor must run in MAIN world");
    assert.equal(page.run_at, "document_start", label + ": page interceptor must start early");
    assert.equal(page.all_frames, true, label + ": MAIN must protect every frame");
    for (const field of ["exclude_matches", "include_globs", "exclude_globs", "match_about_blank", "css"]) {
      assert.equal(Object.hasOwn(page, field), false,
        label + ": MAIN-world entry must not gain unreviewed routing or CSS " + field);
    }
  }
  const content = manifest.content_scripts[chromiumVariant ? 1 : 0];
  assert.equal(content.world, undefined,
    label + ": privileged content must retain the default ISOLATED world");
  assert.deepEqual(asSortedSet(content.matches, label + " URL matches"), ["<all_urls>"]);
  assert.deepEqual(asSortedSet(content.js, label + " content JS"), ["content.js"]);
  assert.equal(content.run_at, "document_start", label + ": early protection must be preserved");
  assert.equal(content.all_frames, true, label + ": popup filtering must cover frames");
  for (const key of ["exclude_matches", "include_globs", "exclude_globs", "match_about_blank"]) {
    assert.equal(Object.hasOwn(content, key), false,
      label + ": unreviewed content-script routing " + key);
  }

  if (chromiumVariant) {
    assert.equal(manifest.background?.service_worker, "background.js",
      label + ": reviewed service worker required");
    assert.equal(manifest.action?.default_popup, "popup.html",
      label + ": reviewed popup required");
  } else {
    assert.deepEqual(asSortedSet(manifest.background?.scripts, label + " background"),
      ["background.js"]);
    assert.equal(manifest.browser_action?.default_popup, "popup.html",
      label + ": reviewed popup required");
  }
}

validate(chromium, "chromium");
validate(firefox, "firefox");
validate(bundled, "bundled");
assert.deepEqual(bundled, chromium, "bundled zGuard manifest must equal Chromium manifest");

const clone = (item) => JSON.parse(JSON.stringify(item));
const unsafe = [
  ["extra permission", (m) => m.permissions.push("cookies")],
  ["duplicate permission", (m) => m.permissions.push("tabs")],
  ["optional permissions", (m) => { m.optional_permissions = ["scripting"]; }],
  ["external connect", (m) => { m.externally_connectable = { matches: ["<all_urls>"] }; }],
  ["remote accessible resources", (m) => { m.web_accessible_resources = [{resources:["*"],matches:["<all_urls>"]}]; }],
  ["unreviewed CSP", (m) => { m.content_security_policy = {extension_pages:"script-src 'unsafe-eval'"}; }],
  ["additional host", (m) => m.host_permissions.push("https://collector.example/*")],
  ["late content load", (m) => { m.content_scripts[0].run_at = "document_idle"; }],
  ["no frame coverage", (m) => { m.content_scripts[0].all_frames = false; }],
  ["excluded sites", (m) => { m.content_scripts[0].exclude_matches = ["https://example.test/*"]; }],
  ["extra content script", (m) => m.content_scripts[0].js.push("remote.js")],
  ["additional injection entry", (m) => m.content_scripts.push(clone(m.content_scripts[0]))],
  ["swapped popup", (m) => { m.action.default_popup = "remote.html"; }]
];
for (const [label, mutation] of unsafe) {
  const fixture = clone(chromium);
  mutation(fixture);
  assert.throws(() => validate(fixture, "mutant " + label),
    undefined, label + " must be rejected");
}

const workflow = fs.readFileSync(path.join(root,
  ".github/workflows/zguard-extension-permission-boundary.yml"), "utf8");
for (const expected of [
  "pull_request:", "push:", "workflow_dispatch:",
  "timeout-minutes: 5", "contents: read",
  "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
  "persist-credentials: false", "git rev-parse HEAD", "EXPECTED_SHA:",
  "node tests/zguard.extension-permission-boundary.test.mjs"
]) {
  assert.ok(workflow.includes(expected), "Permission workflow missing " + expected);
}
assertVpsOwnerGuardedJob(workflow, "Permission workflow");
assert.doesNotMatch(workflow, /^\s+paths:\s*$/m,
  "Permission protection must run on every PR/push");
console.log("zGuard extension permission surface validated across three packages");
