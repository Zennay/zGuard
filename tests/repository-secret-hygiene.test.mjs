import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const signatures = [
  {
    name: "PEM private key",
    pattern: new RegExp("-----BEGIN " + "(?:(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----")
  },
  { name: "GitHub classic token", pattern: new RegExp("(?<![A-Za-z0-9_])gh" + "[opusr]_[A-Za-z0-9]{20,}") },
  { name: "GitHub fine-grained token", pattern: new RegExp("(?<![A-Za-z0-9_])github" + "_pat_[A-Za-z0-9_]{20,}") },
  { name: "OpenAI-style secret", pattern: new RegExp("(?<![A-Za-z0-9])sk" + "-[A-Za-z0-9_-]{20,}") },
  { name: "AWS access key id", pattern: new RegExp("(?<![A-Za-z0-9_])AK" + "IA[0-9A-Z]{16}") },
  { name: "Slack bot token", pattern: new RegExp("(?<![A-Za-z0-9_])xox" + "b-[0-9A-Za-z-]{20,}") }
];

// A token marker is a separate prefix, not the trailing letters of an
// ordinary word. For example a long QA filename beginning with "kiosk-"
// contains "sk-" mid-word, which is NOT an API key. Keep standalone keys
// in JSON, shell assignment and HTTP Authorization text detectable.
const tokenPattern = signatures.find(item =>
  item.name === "OpenAI-style secret")?.pattern;
assert.ok(tokenPattern, "reviewed token pattern must exist");
function verifyTokenBoundary(pattern) {
  const simulatedKey = "sk" + "-" + "A".repeat(32);
  for (const real of [
    simulatedKey,
    "KEY=" + simulatedKey,
    "Bearer " + simulatedKey,
    "{\"key\":\"" + simulatedKey + "\"}",
    "(" + simulatedKey + ")"
  ]) {
    assert.equal(pattern.test(real), true,
      "standalone API token must still be detected regardless of wrapping");
  }
for (const harmless of [
    "kiosk-coldstart-launch-real-shell.test.mjs",
    "prefix" + simulatedKey,
    "task" + simulatedKey,
    "sk" + "-" + "A".repeat(19)
  ]) {
    assert.equal(pattern.test(harmless), false,
      "embedded or short token-like text must not trip secret hygiene");
  }
}
verifyTokenBoundary(tokenPattern);

// Prefixed markers inside ordinary identifiers are not standalone credentials.
// The same boundary rule applies to GitHub, AWS and Slack token families,
// while assignment, Bearer headers and quoted keys remain detectable.
function verifyCredentialBoundary(pattern, token, label) {
  for (const text of [
    token, "GITHUB_TOKEN=" + token, "Bearer " + token,
    '{"credential":"' + token + '"}', "(" + token + ")"
  ]) {
    assert.equal(pattern.test(text), true,
      label + ": standalone credential must still be detected");
  }
  for (const text of [
    "prefix" + token, "task" + token, "filename_" + token,
    token.slice(0, -12)
  ]) {
    assert.equal(pattern.test(text), false,
      label + ": embedded or truncated token-like text is not a secret");
  }
}
for (const [name, synthetic, oldPattern] of [
  ["GitHub classic token", "gh" + "p_" + "B".repeat(30),
    new RegExp("gh" + "[opusr]_[A-Za-z0-9]{20,}")],
  ["GitHub fine-grained token", "github" + "_pat_" + "C".repeat(30),
    new RegExp("github" + "_pat_[A-Za-z0-9_]{20,}")],
  ["AWS access key id", "AK" + "IA" + "D".repeat(16),
    new RegExp("AK" + "IA[0-9A-Z]{16}")],
  ["Slack bot token", "xox" + "b-" + "E".repeat(30),
    new RegExp("xox" + "b-[0-9A-Za-z-]{20,}")]
]) {
  const pattern = signatures.find(signature => signature.name === name)?.pattern;
  assert.ok(pattern, name + ": matcher must remain registered");
  verifyCredentialBoundary(pattern, synthetic, name);
  assert.throws(() => verifyCredentialBoundary(oldPattern, synthetic, name),
    undefined, name + ": removing the identifier boundary must break the test");
}
// Prove that a regression to the old unbounded-prefix detector fails QA.
assert.throws(() => verifyTokenBoundary(new RegExp("sk" + "-[A-Za-z0-9_-]{20,}")),
  undefined, "removing the token boundary must be caught by this self-test");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8"
}).split("\0").filter(Boolean);

assert.ok(tracked.length > 0, "at least one tracked file must be discovered");

// UTF-32 text stores each ASCII token byte with three NULs. Only printable
// ASCII codepoints are relevant to the high-confidence signatures below.
// Replace every other codepoint with NUL so invalid quads cannot stitch a
// false credential together across arbitrary binary padding.
function utf32AsciiView(buffer, offset, bigEndian) {
  const decoded = Buffer.alloc(Math.floor((buffer.length - offset) / 4));
  for (let index = 0; index < decoded.length; index++) {
    const base = offset + index * 4;
    const ascii = buffer[base + (bigEndian ? 3 : 0)];
    const padding = bigEndian
      ? buffer[base] === 0 && buffer[base + 1] === 0 && buffer[base + 2] === 0
      : buffer[base + 1] === 0 && buffer[base + 2] === 0 && buffer[base + 3] === 0;
    if (padding && ascii >= 0x20 && ascii <= 0x7e) decoded[index] = ascii;
  }
  return decoded.toString("latin1");
}

// Preserve ASCII even in binary blobs. Also decode UTF-16 and UTF-32 bytes
// in both orders and every byte alignment, including BOM-less encodings.
// Never skip a tracked file merely because it contains NUL or invalid UTF-8.
function scanBytes(buffer) {
  const views = [buffer.toString("latin1")];
  if (buffer.includes(0)) {
    for (const offset of [0, 1]) {
      const aligned = buffer.subarray(offset);
      const even = aligned.subarray(0, aligned.length - aligned.length % 2);
      if (even.length === 0) continue;
      views.push(even.toString("utf16le"));
      // Buffer.swap16() mutates: make a copy so a probe cannot rewrite
      // the caller's bytes (or alter a later file-integrity check).
      views.push(Buffer.from(even).swap16().toString("utf16le"));
    }
    for (const offset of [0, 1, 2, 3]) {
      views.push(utf32AsciiView(buffer, offset, false));
      views.push(utf32AsciiView(buffer, offset, true));
    }
  }
  return signatures.filter(signature =>
    views.some(view => signature.pattern.test(view)))
    .map(signature => signature.name);
}

// Synthetic secrets are assembled at runtime, never committed as token-like
// literals. This test covers binary concealment as well as legitimate text.
const examples = [
  ["OpenAI-style secret", "sk" + "-" + "A".repeat(32)],
  ["GitHub classic token", "gh" + "p_" + "B".repeat(30)],
  ["GitHub fine-grained token", "github" + "_pat_" + "C".repeat(30)],
  ["AWS access key id", "AK" + "IA" + "D".repeat(16)],
  ["Slack bot token", "xox" + "b-" + "E".repeat(30)],
  ["PEM private key", "-----BEGIN " + "PRIVATE KEY-----"],
  ["PEM private key", "-----BEGIN " + "DSA PRIVATE KEY-----"],
  ["PEM private key", "-----BEGIN " + "ENCRYPTED PRIVATE KEY-----"],
  ["PEM private key", "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----"]
];
for (const [name, synthetic] of examples) {
  const binary = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x80]),
    Buffer.from("prefix " + synthetic + " suffix", "ascii"),
    Buffer.from([0x00, 0x01])
  ]);
  assert.ok(scanBytes(binary).includes(name),
    name + ": NUL and non-UTF8 padding must not hide a tracked secret");
  assert.ok(scanBytes(Buffer.from(synthetic, "ascii")).includes(name),
    name + ": ordinary text must remain scanned too");
}
// Unicode-encoded secrets must not bypass high-confidence detection.
// Both byte orders, BOM-less buffers and odd/even byte alignment are covered;
// a raw Latin-1-only scanner necessarily misses these test fixtures.
for (const [name, synthetic] of examples) {
  const le = Buffer.from(synthetic, "utf16le");
  for (const [endian, encoded] of [
    ["LE", le],
    ["BE", Buffer.from(le).swap16()]
  ]) {
    for (const offset of [0, 1]) {
      const binary = Buffer.concat([
        Buffer.alloc(offset, 0xff), encoded, Buffer.from([0])
      ]);
      assert.ok(scanBytes(binary).includes(name),
        name + ": UTF-16" + endian + " secret at byte offset " + offset +
        " must be rejected even without a BOM");
    }
  }
}
for (const [name, synthetic] of examples.slice(0, 2)) {
  const le = Buffer.from(synthetic, "utf16le");
  const be = Buffer.from(le).swap16();
  assert.ok(scanBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), le])).includes(name),
    "UTF-16LE BOM must not mask " + name);
  assert.ok(scanBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).includes(name),
    "UTF-16BE BOM must not mask " + name);
}
// UTF-32LE/BE is also used in some exported text; scan all alignments rather
// than trusting a BOM or assuming a particular binary payload boundary.
function encodeUtf32Ascii(value, bigEndian) {
  const bytes = Buffer.alloc(value.length * 4);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    assert.ok(code >= 0x20 && code <= 0x7e,
      "synthetic UTF-32 fixtures must use printable ASCII only");
    bytes[index * 4 + (bigEndian ? 3 : 0)] = code;
  }
  return bytes;
}
for (const [name, synthetic] of examples) {
  for (const [label, bigEndian] of [["LE", false], ["BE", true]]) {
    const encoded = encodeUtf32Ascii(synthetic, bigEndian);
    for (const offset of [0, 1, 2, 3]) {
      const input = Buffer.concat([
        Buffer.alloc(offset, 0xff), encoded, Buffer.from([0, 255])
      ]);
      assert.ok(scanBytes(input).includes(name),
        name + ": BOM-less UTF-32" + label + " at offset " + offset +
          " must not bypass secret hygiene");
    }
  }
}
for (const [label, bigEndian, bom] of [
  ["LE", false, [0xff, 0xfe, 0x00, 0x00]],
  ["BE", true, [0x00, 0x00, 0xfe, 0xff]]
]) {
  const input = Buffer.concat([
    Buffer.from(bom), encodeUtf32Ascii(examples[0][1], bigEndian)
  ]);
  assert.ok(scanBytes(input).includes(examples[0][0]),
    "UTF-32" + label + " BOM must not mask the synthetic API secret");
}
for (const label of ["PUBLIC KEY", "CERTIFICATE", "PGP PUBLIC KEY BLOCK"]) {
  for (const bigEndian of [false, true]) {
    const input = encodeUtf32Ascii("-----BEGIN " + label + "-----", bigEndian);
    assert.deepEqual(scanBytes(input), [],
      "UTF-32 public-key and certificate fixtures are not credentials");
  }
}
// Mutation control: a UTF-16-and-ASCII-only scanner cannot decode UTF-32.
const oldUtf16Only = Buffer.from(encodeUtf32Ascii(examples[0][1], false));
const oldViews = [oldUtf16Only.toString("latin1")];
for (const offset of [0, 1]) {
  const aligned = oldUtf16Only.subarray(offset);
  const even = aligned.subarray(0, aligned.length - aligned.length % 2);
  oldViews.push(even.toString("utf16le"));
  oldViews.push(Buffer.from(even).swap16().toString("utf16le"));
}
assert.ok(!oldViews.some(view =>
  signatures.some(signature => signature.pattern.test(view))),
  "UTF-32 fixture must fail without the new decoder");
assert.ok(scanBytes(oldUtf16Only).includes(examples[0][0]),
  "the production scanner must recover the UTF-32 synthetic secret");

// Mutation control: a scanner restricted to raw byte-preserving Latin-1
// would falsely accept a real UTF-16 encoded secret.
assert.throws(() => {
  const encoded = Buffer.from(examples[0][1], "utf16le");
  assert.ok(signatures.some(signature =>
    signature.name === examples[0][0] &&
    signature.pattern.test(encoded.toString("latin1"))));
}, undefined, "a Latin-1-only regression must fail Unicode token acceptance");

for (const harmless of [
  Buffer.from("-----BEGIN " + "PUBLIC KEY-----", "ascii"),
  Buffer.from("-----BEGIN " + "CERTIFICATE-----", "ascii"),
  Buffer.from("-----BEGIN " + "PGP PUBLIC KEY BLOCK-----", "ascii"),
  Buffer.from([0, 255, 128, 0]),
  Buffer.from("kiosk-coldstart-launch-real-shell.test.mjs\0", "utf8"),
  Buffer.from("sk" + "-" + "A".repeat(19) + "\0", "utf8"),
  Buffer.from("prefix" + "gh" + "p_" + "B".repeat(30), "ascii"),
  Buffer.from("filename_" + "github" + "_pat_" + "C".repeat(30), "ascii"),
  Buffer.from("prefix" + "AK" + "IA" + "D".repeat(16), "ascii"),
  Buffer.from("filename_" + "xox" + "b-" + "E".repeat(30), "ascii")
]) {
  assert.deepEqual(scanBytes(harmless), [],
    "benign binary and embedded/short markers must remain allowed");
}
// The previous NUL early-return must demonstrably fail the binary fixture.
assert.throws(() => {
  const sample = Buffer.concat([Buffer.from([0]), Buffer.from(examples[0][1])]);
  const skipped = sample.includes(0) ? [] : scanBytes(sample);
  assert.ok(skipped.includes(examples[0][0]));
}, undefined, "the old binary-skip scanner is not an acceptable regression");

// Never print a raw Git filename into CI diagnostics: a repository path can
// legally contain newlines and terminal-control bytes that spoof log entries.
// JSON-escape the path while keeping the signature name (not secret value).
const findings = [];
for (const relative of tracked) {
  const matches = scanBytes(fs.readFileSync(path.join(root, relative)));
  for (const name of matches) findings.push({ file: relative, signature: name });
}

assert.deepEqual(
  findings,
  [],
  "tracked repository content contains high-confidence secret material: " +
    findings.map(({ file, signature }) => `${JSON.stringify(file)} (${signature})`).join(", ")
);

const envExample = fs.readFileSync(path.join(root, "zbrowse/.env.example"), "utf8");
for (const line of envExample.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const [key, ...rest] = line.split("=");
  const value = rest.join("=");
  assert.ok(value.length > 0, `${key}: tracked example values must be explicit placeholders/defaults`);
  assert.doesNotMatch(
    key,
    /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/i,
    `${key}: secret-bearing variables must not be committed with tracked example values`
  );
}

console.log(`repository secret hygiene contract passed for ${tracked.length} tracked files`);
