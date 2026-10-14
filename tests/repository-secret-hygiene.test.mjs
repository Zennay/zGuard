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
  { name: "GitHub classic token", pattern: new RegExp("gh" + "[opusr]_[A-Za-z0-9]{20,}") },
  { name: "GitHub fine-grained token", pattern: new RegExp("github" + "_pat_[A-Za-z0-9_]{20,}") },
  { name: "OpenAI-style secret", pattern: new RegExp("(?<![A-Za-z0-9])sk" + "-[A-Za-z0-9_-]{20,}") },
  { name: "AWS access key id", pattern: new RegExp("AK" + "IA[0-9A-Z]{16}") },
  { name: "Slack bot token", pattern: new RegExp("xox" + "b-[0-9A-Za-z-]{20,}") }
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
// Prove that a regression to the old unbounded-prefix detector fails QA.
assert.throws(() => verifyTokenBoundary(new RegExp("sk" + "-[A-Za-z0-9_-]{20,}")),
  undefined, "removing the token boundary must be caught by this self-test");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8"
}).split("\0").filter(Boolean);

assert.ok(tracked.length > 0, "at least one tracked file must be discovered");

// Secret bytes may appear as ASCII even inside a binary blob, or as UTF-16
// text with a NUL after each ASCII code unit (e.g. PowerShell/Windows exports).
// Preserve raw bytes in Latin-1; inspect both UTF-16 orders/alignment only
// when binary NULs are actually present. Never silently skip any tracked file.
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
  Buffer.from("sk" + "-" + "A".repeat(19) + "\0", "utf8")
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

const findings = [];
for (const relative of tracked) {
  const matches = scanBytes(fs.readFileSync(path.join(root, relative)));
  for (const name of matches) findings.push({ file: relative, signature: name });
}

assert.deepEqual(
  findings,
  [],
  "tracked repository content contains high-confidence secret material: " +
    findings.map(({ file, signature }) => `${file} (${signature})`).join(", ")
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
