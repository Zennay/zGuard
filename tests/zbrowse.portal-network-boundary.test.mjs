import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portalPath = "zbrowse/gateway/public/app.js";

function quotedLeadingArgumentCalls(source, calleePattern) {
  const matches = [];
  const pattern = new RegExp(
    "\\b" + calleePattern + "\\s*\\(\\s*([\\\"'])([^\\\"']*?)\\1",
    "g"
  );

  for (const match of source.matchAll(pattern)) {
    matches.push({ argument: match[2], index: match.index });
  }
  return matches;
}

function validatePortalNetworkBoundary(source, label) {
  const findings = [];

  const fetchCalls = [...source.matchAll(/\bfetch\s*\(/g)];
  if (fetchCalls.length !== 1) {
    findings.push(
      `${label}: must contain exactly one fetch() call inside the reviewed request() helper; found ${fetchCalls.length}`
    );
  }

  const helper = source.match(
    /async function request\(url, options = \{\}\) \{([\s\S]*?)\n\}/
  );
  if (!helper || !/\bfetch\s*\(\s*url\s*,/.test(helper[1])) {
    findings.push(
      `${label}: request() must remain the single direct fetch() wrapper and fetch its url argument`
    );
  }

  for (const primitive of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
    if (new RegExp(`\\b${primitive}\\s*\\(`).test(source)) {
      findings.push(`${label}: unreviewed network primitive ${primitive}() is forbidden`);
    }
  }

  const requestInvocationCount =
    [...source.matchAll(/\brequest\s*\(/g)].length -
    [...source.matchAll(/\bfunction\s+request\s*\(/g)].length;
  const requestCalls = quotedLeadingArgumentCalls(source, "request");

  if (requestCalls.length !== requestInvocationCount) {
    findings.push(
      `${label}: every request() call must begin with a literal same-origin /api/ path`
    );
  }

  for (const call of requestCalls) {
    if (!call.argument.startsWith("/api/")) {
      findings.push(
        `${label}: request() target must stay under same-origin /api/; got ${JSON.stringify(call.argument)}`
      );
    }
  }

  const beaconInvocationCount = [...source.matchAll(/\bnavigator\.sendBeacon\s*\(/g)].length;
  const beaconCalls = quotedLeadingArgumentCalls(source, "navigator\\.sendBeacon");

  if (beaconCalls.length !== beaconInvocationCount) {
    findings.push(
      `${label}: every navigator.sendBeacon() call must begin with a literal same-origin /api/ path`
    );
  }

  for (const call of beaconCalls) {
    if (!call.argument.startsWith("/api/")) {
      findings.push(
        `${label}: sendBeacon target must stay under same-origin /api/; got ${JSON.stringify(call.argument)}`
      );
    }
  }

  return findings;
}

const safeFixture = `
async function request(url, options = {}) {
  const response = await fetch(url, options);
  return response;
}
request("/api/health");
request("/api/session/" + token + "/heartbeat");
navigator.sendBeacon("/api/session/" + token + "/heartbeat", "{}");
`;
assert.deepEqual(
  validatePortalNetworkBoundary(safeFixture, "safe fixture"),
  [],
  "safe same-origin API calls must remain allowed"
);

for (const [name, source, expected] of [
  [
    "external request",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("https://example.com/collect");
`,
    /same-origin \/api\//
  ],
  [
    "nonliteral request",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request(targetUrl);
`,
    /literal same-origin/
  ],
  [
    "direct fetch",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
fetch("/api/extra");
`,
    /exactly one fetch/
  ],
  [
    "websocket",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
new WebSocket("wss://example.com/socket");
`,
    /WebSocket/
  ],
  [
    "external beacon",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
navigator.sendBeacon("//example.com/collect", "{}");
`,
    /sendBeacon target/
  ]
]) {
  const findings = validatePortalNetworkBoundary(source, name);
  assert.ok(
    findings.some((finding) => expected.test(finding)),
    `${name} self-test failed:\n${findings.join("\n")}`
  );
}

const portal = fs.readFileSync(path.join(root, portalPath), "utf8");
const findings = validatePortalNetworkBoundary(portal, portalPath);

assert.deepEqual(
  findings,
  [],
  `zBrowse portal network boundary failed:\n${findings.join("\n")}`
);

console.log("zBrowse portal same-origin network boundary passed");
