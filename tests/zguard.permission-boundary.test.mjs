import assert from "node:assert/strict";
import fs from "node:fs";

const readJson = (relative) =>
  JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), "utf8"));

const chromium = readJson("../chromium/manifest.json");
const firefox = readJson("../firefox/manifest.json");

const sorted = (values = []) => [...values].sort();

assert.deepEqual(
  sorted(chromium.permissions),
  ["storage", "tabs"],
  "Chromium permissions must stay limited to storage and tabs"
);
assert.deepEqual(
  sorted(chromium.host_permissions),
  ["<all_urls>"],
  "Chromium host access must remain the single reviewed all-URLs boundary"
);
assert.equal(
  chromium.optional_permissions,
  undefined,
  "Chromium must not add optional permissions without an explicit QA review"
);
assert.equal(
  chromium.optional_host_permissions,
  undefined,
  "Chromium must not add optional host permissions without an explicit QA review"
);

assert.deepEqual(
  sorted(firefox.permissions),
  ["<all_urls>", "storage", "tabs"],
  "Firefox permissions must stay limited to storage, tabs and the reviewed all-URLs boundary"
);
assert.equal(
  firefox.optional_permissions,
  undefined,
  "Firefox must not add optional permissions without an explicit QA review"
);

for (const [name, manifest] of [["Chromium", chromium], ["Firefox", firefox]]) {
  const text = JSON.stringify(manifest);
  for (const forbidden of [
    "bookmarks",
    "clipboardRead",
    "clipboardWrite",
    "cookies",
    "downloads",
    "history",
    "management",
    "nativeMessaging",
    "privacy",
    "proxy",
    "webRequest",
    "webRequestBlocking"
  ]) {
    assert.equal(
      text.includes(`"${forbidden}"`),
      false,
      `${name} must not gain sensitive permission ${forbidden} without explicit QA review`
    );
  }
}

console.log("zGuard permission boundary contract passed");
