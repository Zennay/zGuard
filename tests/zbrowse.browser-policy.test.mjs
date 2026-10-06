import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const policy = JSON.parse(read("../zbrowse/browser/policies/policy.json"));
const sites = JSON.parse(read("../zbrowse/gateway/config/sites.json"));
const startup = read("../zbrowse/browser/root/usr/local/bin/start-zbrowse");

assert.deepEqual(policy.URLBlocklist, ["*"], "browser policy must remain deny-by-default");
assert.equal(policy.DownloadRestrictions, 3, "downloads must remain disabled");
assert.equal(policy.DefaultPopupsSetting, 2, "browser-level popups must remain blocked");
assert.equal(policy.DefaultNotificationsSetting, 2, "notifications must remain blocked");
assert.equal(policy.DefaultGeolocationSetting, 2, "geolocation prompts must remain blocked");
assert.equal(policy.DeveloperToolsAvailability, 2, "DevTools must remain disabled in the kiosk session");
assert.equal(policy.PrintingEnabled, false, "printing must remain disabled");
assert.equal(policy.PasswordManagerEnabled, false, "password storage must remain disabled");
assert.equal(policy.AutofillAddressEnabled, false, "address autofill must remain disabled");
assert.equal(policy.AutofillCreditCardEnabled, false, "credit-card autofill must remain disabled");
assert.ok(policy.SafeBrowsingProtectionLevel >= 1, "Safe Browsing must remain enabled");

const configuredHosts = new Set(
  sites.map((site) => new URL(site.url).hostname.toLowerCase())
);
assert.ok(configuredHosts.size > 0, "at least one configured site host is required");
assert.ok(Array.isArray(policy.URLAllowlist) && policy.URLAllowlist.length > 0);

for (const entry of policy.URLAllowlist) {
  const match = /^https:\/\/(\*\.)?([^/:]+)\/\*$/i.exec(entry);
  assert.ok(match, "browser allowlist entries must be HTTPS host patterns only: " + entry);
  const host = match[2].toLowerCase();
  assert.ok(
    configuredHosts.has(host),
    "browser policy must not allow an unconfigured host: " + entry
  );
}

for (const host of configuredHosts) {
  assert.ok(
    policy.URLAllowlist.includes("https://" + host + "/*") ||
      policy.URLAllowlist.includes("https://*." + host + "/*"),
    "configured site host must be represented in browser policy: " + host
  );
}

const forbiddenFlags = [
  "--remote-debugging-port",
  "--remote-debugging-pipe",
  "--disable-web-security",
  "--ignore-certificate-errors",
  "--allow-running-insecure-content",
  "--disable-site-isolation-trials"
];
for (const forbiddenFlag of forbiddenFlags) {
  assert.equal(
    startup.includes(forbiddenFlag),
    false,
    "browser startup must not weaken isolation with " + forbiddenFlag
  );
}

assert.match(startup, /--kiosk\b/, "browser must remain in kiosk mode");
assert.match(startup, /--disable-extensions-except=\/opt\/zguard\b/, "only zGuard may be loaded");
assert.match(startup, /--load-extension=\/opt\/zguard\b/, "zGuard must be loaded");

console.log("zBrowse browser policy hardening contract passed");
