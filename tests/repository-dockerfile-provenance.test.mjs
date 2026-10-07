import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8"
}).split("\0").filter(Boolean);

const dockerfiles = tracked
  .filter((file) => /(^|\/)Dockerfile(?:\.[^/]+)?$/.test(file))
  .sort();

assert.ok(dockerfiles.length > 0, "repository must contain tracked Dockerfiles");

function logicalInstructions(source) {
  const logical = [];
  const lines = source.split(/\r?\n/);
  let pending = "";

  for (const line of lines) {
    if (!pending && (line.trim() === "" || line.trimStart().startsWith("#"))) {
      continue;
    }

    const continued = /\\\s*$/.test(line);
    const fragment = continued ? line.replace(/\\\s*$/, "") : line;
    pending += pending ? `\n${fragment}` : fragment;

    if (continued) continue;

    const statement = pending.trim();
    pending = "";
    if (statement) logical.push(statement);
  }

  assert.equal(pending, "", "Dockerfile must not end with an unterminated continuation");
  return logical;
}

function fromImage(argument) {
  let rest = argument.trim();
  while (rest.startsWith("--")) {
    const flag = rest.match(/^--[^\s]+\s+/);
    assert.ok(flag, `malformed FROM flag: ${argument}`);
    rest = rest.slice(flag[0].length);
  }
  return rest.split(/\s+/)[0] || "";
}

function validateDockerfileProvenance(source, label) {
  const instructions = logicalInstructions(source);
  let fromCount = 0;

  for (const statement of instructions) {
    const match = statement.match(/^([A-Za-z]+)\s+([\s\S]+)$/);
    if (!match) continue;

    const instruction = match[1].toUpperCase();
    const argument = match[2].trim();

    assert.notEqual(
      instruction,
      "ADD",
      `${label}: ADD is forbidden; use COPY for local build-context files so extraction and remote-fetch semantics stay explicit`
    );

    if (instruction !== "FROM") continue;
    fromCount += 1;

    const image = fromImage(argument);
    if (image.toLowerCase() === "scratch") continue;

    assert.match(
      image,
      /^[^@\s]+@sha256:[0-9a-f]{64}$/i,
      `${label}: FROM image must be immutable and pinned to a sha256 digest: ${image}`
    );
  }

  assert.ok(fromCount > 0, `${label}: expected at least one FROM instruction`);
}

const digest = "a".repeat(64);
assert.doesNotThrow(() => validateDockerfileProvenance(
  `FROM node:22-alpine@sha256:${digest}\nCOPY app.js /app/app.js\n`,
  "self-test pinned"
));
assert.doesNotThrow(() => validateDockerfileProvenance(
  "FROM scratch\nCOPY artifact /artifact\n",
  "self-test scratch"
));
assert.throws(
  () => validateDockerfileProvenance("FROM node:22-alpine\n", "self-test tag"),
  /must be immutable and pinned/
);
assert.throws(
  () => validateDockerfileProvenance("FROM ${BASE_IMAGE}\n", "self-test variable"),
  /must be immutable and pinned/
);
assert.throws(
  () => validateDockerfileProvenance(
    `FROM node:22-alpine@sha256:${digest}\nADD bundle.tar.gz /app/\n`,
    "self-test ADD"
  ),
  /ADD is forbidden/
);

for (const file of dockerfiles) {
  validateDockerfileProvenance(fs.readFileSync(path.join(root, file), "utf8"), file);
}

console.log(
  `Dockerfile provenance contract passed for ${dockerfiles.length} tracked files`
);
