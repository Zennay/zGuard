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

// Prefix checks alone permit "/api/../other": browsers normalize it to
// "/other" before any request is sent. Bind each literal to its effective URL.
function isCanonicalApiLiteral(literal) {
  if (!literal.startsWith("/api/")) return false;
  if (/[?#\\]/.test(literal) || /%(?:2e|2f|5c)/i.test(literal)) return false;
  try {
    const parsed = new URL(literal, "https://zbrowse.invalid");
    return parsed.origin === "https://zbrowse.invalid" &&
      parsed.pathname === literal && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

for (const pathLiteral of ["/api/health", "/api/session/", "/api/v1/health"]) {
  assert.equal(isCanonicalApiLiteral(pathLiteral), true, `${pathLiteral}: safe API literal`);
}
for (const pathLiteral of [
  "/api/../private", "/api/%2e%2e/private", "/api/x/../private",
  "/api/%2f%2fexample.test", "/api/%5cprivate",
  "/api/health?redirect=other", "/api/health#fragment",
  "/api/\\\\private", "/private", "//example.test/api/health"
]) {
  assert.equal(isCanonicalApiLiteral(pathLiteral), false, `${pathLiteral}: unsafe API literal`);
}

function validatePortalNetworkBoundary(source, label) {
  const findings = [];

  const fetchCalls = [...source.matchAll(/\bfetch\s*\(/g)];
  if (fetchCalls.length !== 1) {
    findings.push(
      `${label}: must contain exactly one fetch() call inside the reviewed request() helper; found ${fetchCalls.length}`
    );
  }

  // A direct-call count alone misses aliases like const leak = window.fetch.
  // Permit only the single token of the reviewed wrapper's fetch() call.
  const fetchReferences = [...source.matchAll(/\bfetch\b/g)];
  if (fetchReferences.length !== fetchCalls.length) {
    findings.push(
      `${label}: indirect fetch references and aliases are forbidden; found ${fetchReferences.length} references for ${fetchCalls.length} direct calls`
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
    if (new RegExp(`\\b${primitive}\\b`).test(source)) {
      findings.push(`${label}: unreviewed network primitive ${primitive} is forbidden even through aliases`);
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
    if (!isCanonicalApiLiteral(call.argument)) {
      findings.push(
        `${label}: request() target must remain a canonical same-origin /api/ path; got ${JSON.stringify(call.argument)}`
      );
    }
  }

  const beaconInvocationCount = [...source.matchAll(/\bnavigator\.sendBeacon\s*\(/g)].length;
  const beaconCalls = quotedLeadingArgumentCalls(source, "navigator\\.sendBeacon");
  const beaconReferences = [...source.matchAll(/\bsendBeacon\b/g)].length;
  if (beaconReferences !== beaconInvocationCount) {
    findings.push(
      `${label}: indirect sendBeacon access or alias is forbidden`
    );
  }


  if (beaconCalls.length !== beaconInvocationCount) {
    findings.push(
      `${label}: every navigator.sendBeacon() call must begin with a literal same-origin /api/ path`
    );
  }

  for (const call of beaconCalls) {
    if (!isCanonicalApiLiteral(call.argument)) {
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
  ],
  [
    "fetch alias alongside approved wrapper",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
const leak = window.fetch;
leak("https://example.com/collect");
`,
    /indirect fetch references/
  ],
  [
    "computed fetch property alongside approved wrapper",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
window["fetch"]("https://example.com/collect");
`,
    /indirect fetch references/
  ],
  [
    "constructor alias",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
const Socket = window.WebSocket;
new Socket("wss://example.com/socket");
`,
    /unreviewed network primitive WebSocket/
  ],
  [
    "normalized traversal request",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/%2e%2e/other");
`,
    /canonical same-origin \/api\//
  ],
  [
    "normalized traversal beacon",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
navigator.sendBeacon("/api/../other", "{}");
`,
    /canonical same-origin \/api\//
  ],
  [
    "beacon alias",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/health");
const beacon = navigator["sendBeacon"];
beacon("https://example.com/collect", "{}");
`,
    /indirect sendBeacon/
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
