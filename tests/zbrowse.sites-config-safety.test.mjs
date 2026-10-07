import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sites = JSON.parse(
  fs.readFileSync(path.join(root, "zbrowse/gateway/config/sites.json"), "utf8")
);

assert.ok(Array.isArray(sites) && sites.length > 0, "sites.json must contain at least one site");

const seenNames = new Set();
const seenOrigins = new Set();

function normalizedIpHost(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLocalOrPrivateIpv4Octets(octets) {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
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

function isLocalOrPrivateIp(hostname) {
  const ip = normalizedIpHost(hostname);
  const version = net.isIP(ip);

  if (version === 4) {
    return isLocalOrPrivateIpv4Octets(ip.split(".").map(Number));
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    const mappedIpv4 = mappedIpv4Octets(lower);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower) ||
      (mappedIpv4 !== null && isLocalOrPrivateIpv4Octets(mappedIpv4))
    );
  }

  return false;
}

assert.equal(isLocalOrPrivateIp("127.0.0.1"), true, "IPv4 loopback must be private");
assert.equal(isLocalOrPrivateIp("::1"), true, "IPv6 loopback must be private");
assert.equal(
  isLocalOrPrivateIp("::ffff:7f00:1"),
  true,
  "IPv4-mapped IPv6 loopback must be private"
);
assert.equal(
  isLocalOrPrivateIp("::ffff:c0a8:101"),
  true,
  "IPv4-mapped IPv6 RFC1918 targets must be private"
);
assert.equal(
  isLocalOrPrivateIp("::ffff:808:808"),
  false,
  "IPv4-mapped public IPv6 targets must remain distinguishable"
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

  const normalizedName = site.name.toLowerCase();
  assert.ok(!seenNames.has(normalizedName), `${site.name}: duplicate site name`);
  seenNames.add(normalizedName);

  const url = new URL(site.url);
  assert.equal(url.protocol, "https:", `${site.name}: only HTTPS targets are allowed`);
  assert.equal(url.username, "", `${site.name}: URL credentials are forbidden`);
  assert.equal(url.password, "", `${site.name}: URL credentials are forbidden`);
  assert.equal(url.search, "", `${site.name}: configured targets must not contain query parameters`);
  assert.equal(url.hash, "", `${site.name}: configured targets must not contain fragments`);
  assert.equal(url.port, "", `${site.name}: configured targets must use the default HTTPS port`);

  const hostname = url.hostname.toLowerCase();
  assert.notEqual(hostname, "localhost", `${site.name}: localhost is not a valid kiosk target`);
  assert.ok(!hostname.endsWith(".localhost"), `${site.name}: localhost subdomains are forbidden`);
  assert.ok(!hostname.endsWith(".local"), `${site.name}: local-network hostnames are forbidden`);
  assert.ok(!isLocalOrPrivateIp(hostname), `${site.name}: local/private IP targets are forbidden`);

  const origin = url.origin.toLowerCase();
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
