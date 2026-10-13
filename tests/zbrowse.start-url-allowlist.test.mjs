import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateway = fs.readFileSync(path.join(root, "zbrowse/gateway/server.js"), "utf8");
const sites = JSON.parse(fs.readFileSync(path.join(root, "zbrowse/gateway/config/sites.json"), "utf8"));

assert.ok(sites.length > 0, "approved gateway sites must not be empty");
const approved = new Set(sites.map(({ url }) => new URL(url).origin.toLowerCase()));
assert.equal(approved.size, sites.length, "each reviewed site must have a distinct origin");

// Execute the actual gateway guard, not a test-side reimplementation.
// Keep it in a sandbox without importing the Docker/gateway entrypoint.
const start = gateway.indexOf("function validStartUrl(");
const finish = gateway.indexOf("async function waitForBrowser(", start);
assert.ok(start >= 0 && finish > start, "gateway must retain a reviewable validStartUrl guard");
const guardSource = gateway.slice(start, finish);
const validStartUrl = vm.runInNewContext(guardSource + "\nvalidStartUrl;", {
  URL,
  allowedOrigins: approved,
  config: { startUrl: sites[0].url }
}, { filename: "zbrowse/gateway/server.js", timeout: 1_000 });
assert.equal(typeof validStartUrl, "function");

const defaultSite = sites[0].url;
for (const value of [undefined, null, "", defaultSite]) {
  assert.equal(
    validStartUrl(value),
    new URL(defaultSite).href,
    "empty URL input must fall back to the reviewed default site only"
  );
}

for (const { url: approvedUrl } of sites) {
  const site = new URL(approvedUrl);
  for (const candidate of [
    approvedUrl,
    site.origin + "/catalogue/episode?sort=latest&lang=en#player",
    site.origin.toUpperCase().replace("HTTPS:", "https:") + "/path",
    site.origin + ":443/standard-port"
  ]) {
    // URL canonicalization is the expected browser navigation target.
    const normalized = new URL(candidate);
    if (normalized.protocol === "https:" && normalized.origin === site.origin) {
      assert.equal(
        validStartUrl(candidate),
        normalized.href,
        "reviewed HTTPS origins must support safe paths, queries and fragments"
      );
    }
  }
}

const hostname = new URL(defaultSite).hostname;
for (const [kind, candidate] of [
  ["HTTP downgrade", "http://" + hostname + "/"],
  ["WebSocket protocol", "wss://" + hostname + "/"],
  ["file protocol", "file:///etc/passwd"],
  ["script scheme", "javascript:alert(1)"],
  ["data URL", "data:text/html,hello"],
  ["protocol-relative URL", "//" + hostname + "/"],
  ["relative URL", "/watch"],
  ["alternate port", "https://" + hostname + ":8443/"],
  ["subdomain", "https://sub." + hostname + "/"],
  ["host suffix", "https://" + hostname + ".attacker.test/"],
  ["deceptive host before @", "https://" + hostname + "@attacker.test/"],
  ["unrelated private host", "https://127.0.0.1/"],
  ["DNS root-dot origin", "https://" + hostname + "./"],
  ["invalid bracket syntax", "https://[bad-host/"],
  ["non-string object", { url: defaultSite }]
]) {
  assert.equal(
    validStartUrl(candidate),
    null,
    kind + ": gateway must not admit an unreviewed navigation target"
  );
}

console.log(
  "zBrowse start-URL allowlist passed for " + sites.length +
  " curated sites and adversarial protocol/origin/port inputs"
);
