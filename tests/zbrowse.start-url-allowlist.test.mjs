import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const requireCredentialFree = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-credential-free');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateway = fs.readFileSync(path.join(root, "zbrowse/gateway/server.js"), "utf8");
const sites = JSON.parse(fs.readFileSync(path.join(root, "zbrowse/gateway/config/sites.json"), "utf8"));

assert.ok(sites.length > 0, "approved gateway sites must not be empty");
// Execute both actual gateway constructs, not test-side reimplementations.
// Keep all gateway side effects isolated: never import its Docker entrypoint.
const allowlistStart = gateway.indexOf("const allowedOrigins = new Set(");
const allowlistEnd = gateway.indexOf("const trustProxyHops", allowlistStart);
const guardStart = gateway.indexOf("function validStartUrl(");
const guardEnd = gateway.indexOf("async function waitForBrowser(", guardStart);
assert.ok(
  allowlistStart >= 0 && allowlistEnd > allowlistStart &&
  guardStart >= 0 && guardEnd > guardStart,
  "gateway must retain reviewable allowlist initialization and validStartUrl guard"
);
const actualCode = gateway.slice(allowlistStart, allowlistEnd) +
  "\n" + gateway.slice(guardStart, guardEnd) +
  "\n({ allowedOrigins, validStartUrl });";
const evaluated = vm.runInNewContext(actualCode, {
  URL,
  sites,
  config: { startUrl: sites[0].url }
}, { filename: "zbrowse/gateway/server.js", timeout: 1_000 });
const { allowedOrigins, validStartUrl } = evaluated;
assert.equal(typeof validStartUrl, "function");
assert.equal(allowedOrigins.size, sites.length, "configured sites must have distinct exact origins");
for (const site of sites) {
  assert.ok(
    allowedOrigins.has(new URL(site.url).origin.toLowerCase()),
    "the runtime allowlist must derive from every reviewed site origin"
  );
}

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

// Opt-in real gateway acceptance for issue #266. Execute the actual
// validStartUrl function extracted above, without recreating its URL policy.
// No embedded credential values are printed to CI logs.
if (requireCredentialFree) {
  const failures = [];
  for (const { url: approvedUrl } of sites) {
    const authority = new URL(approvedUrl).host;
    const credentialInputs = [
      ["username/password", "https://user:pass@" + authority + "/watch"],
      ["username-only", "https://user@" + authority + "/watch"],
      ["password-only", "https://:pass@" + authority + "/watch"],
      ["percent-encoded username", "https://us%65r@" + authority + "/watch"],
      ["percent-encoded password", "https://user:%70ass@" + authority + "/watch"],
      ["canonical HTTPS port", "https://user:pass@" + authority + ":443/watch"]
    ];
    for (const [kind, candidate] of credentialInputs) {
      if (validStartUrl(candidate) !== null) {
        failures.push(kind + " accepted for configured origin #" +
          (sites.indexOf(sites.find((site) => site.url === approvedUrl)) + 1));
      }
    }
  }
  assert.deepEqual(failures, [],
    "validStartUrl admits credential-bearing approved origins (issue #266): " +
    failures.join("; "));
  console.log("Gateway credential-free URL acceptance passed across " +
    sites.length + " approved origins");
}

console.log(
  "zBrowse start-URL allowlist passed for " + sites.length +
  " curated sites and adversarial protocol/origin/port inputs"
);
