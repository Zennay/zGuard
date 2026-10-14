import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sites = JSON.parse(
  fs.readFileSync(path.join(root, "zbrowse/gateway/config/sites.json"), "utf8")
);

assert.ok(Array.isArray(sites) && sites.length > 0 && sites.length <= 32,
  "sites.json must contain 1–32 curated sites to match the TV suggestions cap");

const seenNames = new Set();
const seenOrigins = new Set();

// Keep the source curated-site list deployable in the shipped TV. An invalid
// display name must fail in repository CI rather than disable Open in a kiosk.
function addReviewedLabel(name, names) {
  assert.ok(typeof name === "string" && name.trim() && name.length <= 96,
    "site label must be a nonempty string of at most 96 characters");
  assert.doesNotMatch(name,
    /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/,
    "site label cannot contain control, zero-width or bidi-spoofing characters");
  const key = name.normalize("NFKC").trim().toLowerCase();
  assert.ok(!names.has(key), "visually duplicate curated site name");
  names.add(key);
}

// Negative contract examples ensure this test actually rejects label variants
// that the browser's data-list guard now refuses; accepted normal Unicode is
// an independent positive control.
for (const [label, values] of [
  ["mixed-case duplicates", ["Fawesome", "FAWESOME"]],
  ["fullwidth duplicates", ["Fawesome", "\uFF26\uFF41\uFF57\uFF45\uFF53\uFF4F\uFF4D\uFF45"]],
  ["zero-width format", ["Fawesome\u200b"]],
  ["bidi marker", ["Fawesome\u200f"]],
  ["soft hyphen", ["Faw\u00adesome"]],
  ["empty label", ["  "]],
  ["excessively long label", ["A".repeat(97)]]
]) {
  const names = new Set();
  assert.throws(() => values.forEach(name => addReviewedLabel(name, names)),
    undefined, label + " must be rejected before deployment");
}
const allowedDisplay = new Set();
assert.doesNotThrow(() => ["Fawesome", "Series Élite"].forEach(
  name => addReviewedLabel(name, allowedDisplay)),
  "ordinary distinct readable Unicode names remain supported");

function normalizedIpHost(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

// URL.hostname preserves the optional absolute DNS root dot. Do not let it
// bypass local-zone filtering or make equivalent DNS origins appear distinct.
function canonicalKioskHostname(hostname) {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isLocalDnsName(hostname) {
  return (
    hostname === "localhost" ||
    [".localhost", ".local", ".home.arpa", ".internal"].some(
      (suffix) => hostname.endsWith(suffix)
    )
  );
}

function isNonPublicIpv4Octets(octets) {
  const [a, b, c, d] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, not a public kiosk endpoint
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (
      b === 168 ||
      (b === 0 && (c === 2 || (c === 0 && d !== 9 && d !== 10))) ||
      (b === 88 && c === 99)
    )) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved/broadcast destinations
  );
}

function mappedIpv4Octets(ip) {
  const lower = ip.toLowerCase();
  const dotted = lower.match(
    /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  );
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    return octets.every((value) => value >= 0 && value <= 255) ? octets : null;
  }

  const hexadecimal = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexadecimal) return null;

  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isNonPublicIp(hostname) {
  const ip = normalizedIpHost(hostname);
  const version = net.isIP(ip);

  if (version === 4) {
    return isNonPublicIpv4Octets(ip.split(".").map(Number));
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    const mappedIpv4 = mappedIpv4Octets(lower);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      /^fe[cdef]/.test(lower) || // deprecated site-local fec0::/10
      (lower.split(':')[0] === '3fff' &&
        Number.parseInt(lower.split(':')[1] || '0', 16) < 0x1000) || // RFC 9637 3fff::/20
      lower.startsWith("ff") || // multicast, not a publicly reachable web host
      lower.startsWith("2001:db8:") || // RFC 3849 documentation-only range
      lower === "2001:db8::" ||
      (mappedIpv4 !== null && isNonPublicIpv4Octets(mappedIpv4))
    );
  }

  return false;
}

assert.equal(isNonPublicIp("127.0.0.1"), true, "IPv4 loopback must be private");
assert.equal(isNonPublicIp("::1"), true, "IPv6 loopback must be private");
assert.equal(
  isNonPublicIp("::ffff:7f00:1"),
  true,
  "IPv4-mapped IPv6 loopback must be private"
);
assert.equal(
  isNonPublicIp("::ffff:c0a8:101"),
  true,
  "IPv4-mapped IPv6 RFC1918 targets must be private"
);
assert.equal(
  isNonPublicIp("::ffff:808:808"),
  false,
  "IPv4-mapped public IPv6 targets must remain distinguishable"
);

for (const ip of [
  "100.64.0.1", "100.127.255.254", // RFC 6598 carrier-grade NAT
  "192.0.0.8", "192.0.0.170", // IETF protocol assignments (excluding .9/.10 globally reachable anycast)
  "192.88.99.2", // deprecated 6to4 relay/6a44 anycast
  "fec0::1", "feff::1", // deprecated IPv6 site-local range
  "3fff::1", "3fff:fff::1", // RFC 9637 IPv6 documentation-only prefix
  "198.18.0.1", "198.19.255.254", // RFC 2544 benchmarking
  "192.0.2.7", "198.51.100.7", "203.0.113.7", // TEST-NET
  "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  "::ffff:100.64.0.1", "::ffff:c612:1", "::ffff:cb00:7107",
  "ff02::1", "ff0e::1", "2001:db8::1"
]) {
  assert.equal(isNonPublicIp(ip), true, `${ip}: special-use IP must be rejected`);
}
for (const ip of [
  "8.8.8.8", "1.1.1.1", "192.0.0.9", "192.0.0.10", "192.0.32.1", "::ffff:808:808", "2001:4860:4860::8888"
]) {
  assert.equal(isNonPublicIp(ip), false, `${ip}: valid public IP must remain allowed`);
}


for (const [url, expected] of [
  ["https://localhost./", true],
  ["https://printer.local./", true],
  ["https://sub.localhost.", true],
  ["https://router.home.arpa./", true],
  ["https://app.internal./", true],
  ["https://localhost/", true],
  ["https://www.example.com./", false],
  ["https://local.example.com./", false],
  ["https://8.8.8.8/", false]
]) {
  const hostname = canonicalKioskHostname(new URL(url).hostname);
  assert.equal(isLocalDnsName(hostname), expected, `${url}: local-name classification drift`);
}
assert.equal(
  canonicalKioskHostname(new URL("https://example.com./").hostname),
  canonicalKioskHostname(new URL("https://example.com/").hostname),
  "DNS root-dot variants must share the same origin identity"
);

for (const [index, site] of sites.entries()) {
  assert.equal(
    Object.getPrototypeOf(site),
    Object.prototype,
    `site #${index + 1} must be a plain object`
  );

  const keys = Object.keys(site).sort();
  assert.deepEqual(
    keys,
    ["accent", "description", "name", "url"],
    `${site.name ?? `site #${index + 1}`}: unexpected or missing configuration fields`
  );

  for (const key of ["name", "url", "description", "accent"]) {
    assert.equal(typeof site[key], "string", `${key} must be a string`);
    assert.equal(site[key], site[key].trim(), `${site.name ?? index}: ${key} must be trimmed`);
    assert.ok(site[key].length > 0, `${site.name ?? index}: ${key} must not be empty`);
  }

  addReviewedLabel(site.name, seenNames);
  assert.ok(site.url.length <= 2048,
    `${site.name}: URL exceeds the reviewed TV catalogue limit`);

  const url = new URL(site.url);
  assert.equal(url.protocol, "https:", `${site.name}: only HTTPS targets are allowed`);
  assert.equal(url.username, "", `${site.name}: URL credentials are forbidden`);
  assert.equal(url.password, "", `${site.name}: URL credentials are forbidden`);
  assert.equal(url.search, "", `${site.name}: configured targets must not contain query parameters`);
  assert.equal(url.hash, "", `${site.name}: configured targets must not contain fragments`);
  assert.equal(url.port, "", `${site.name}: configured targets must use the default HTTPS port`);

  const hostname = canonicalKioskHostname(url.hostname);
  assert.ok(!isLocalDnsName(hostname), `${site.name}: local DNS hostnames are forbidden`);
  assert.ok(!isNonPublicIp(hostname), `${site.name}: non-public/special-use IP targets are forbidden`);

  const origin = url.protocol + "//" + hostname;
  assert.ok(!seenOrigins.has(origin), `${site.name}: duplicate origin`);
  seenOrigins.add(origin);

  assert.match(
    site.accent,
    /^#[0-9a-fA-F]{6}$/,
    `${site.name}: accent must be a six-digit hex colour`
  );
}

for (const expected of [
  'repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}',
  'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
  'EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
  'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'
]) {
  assert.ok(
    workflowText().includes(expected),
    `sites config workflow must retain exact-head checkout proof: ${expected}`
  );
}

function workflowText() {
  return fs.readFileSync(
    path.join(root, ".github/workflows/zbrowse-sites-config-safety.yml"),
    "utf8"
  );
}

console.log("zBrowse sites configuration safety contract passed");
