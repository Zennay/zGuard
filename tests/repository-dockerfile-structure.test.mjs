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

const instructions = new Set([
  "ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM",
  "HEALTHCHECK", "LABEL", "MAINTAINER", "ONBUILD", "RUN", "SHELL",
  "STOPSIGNAL", "USER", "VOLUME", "WORKDIR"
]);

const jsonInstructions = new Set([
  "ADD", "CMD", "COPY", "ENTRYPOINT", "RUN", "SHELL", "VOLUME"
]);

function stripLeadingFlags(value) {
  let rest = value.trimStart();
  while (rest.startsWith("--")) {
    const match = rest.match(/^--[^\s]+\s+/);
    if (!match) return rest;
    rest = rest.slice(match[0].length);
  }
  return rest;
}

function validateDockerfile(source, label) {
  const logical = [];
  const lines = source.split(/\r?\n/);
  if (source.endsWith("\n") && lines.at(-1) === "") {
    lines.pop();
  }
  let pending = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

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

  assert.equal(pending, "", `${label}: Dockerfile ends with an unterminated line continuation`);
  assert.ok(logical.length > 0, `${label}: Dockerfile must contain at least one instruction`);

  let seenFrom = false;

  for (const statement of logical) {
    const match = statement.match(/^([A-Za-z]+)(?:\s+([\s\S]*))?$/);
    assert.ok(match, `${label}: malformed Dockerfile instruction: ${statement}`);

    const instruction = match[1].toUpperCase();
    const argument = (match[2] ?? "").trim();

    assert.ok(instructions.has(instruction), `${label}: unknown Dockerfile instruction "${instruction}"`);
    assert.ok(argument, `${label}: ${instruction} requires an argument`);

    if (!seenFrom) {
      assert.ok(
        instruction === "ARG" || instruction === "FROM",
        `${label}: only ARG may appear before the first FROM instruction`
      );
    }

    if (instruction === "FROM") {
      seenFrom = true;
    }

    if (jsonInstructions.has(instruction)) {
      const payload = stripLeadingFlags(argument);
      if (payload.startsWith("[")) {
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch (error) {
          throw new Error(`${label}: invalid JSON form for ${instruction}: ${error.message}`);
        }
        assert.ok(
          Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string"),
          `${label}: JSON-form ${instruction} must be a non-empty array of strings`
        );
      }
    }
  }

  assert.ok(seenFrom, `${label}: Dockerfile must contain a FROM instruction`);
}

assert.doesNotThrow(() => validateDockerfile(
  [
    "# syntax=docker/dockerfile:1",
    "ARG BASE=node:22-alpine",
    "FROM ${BASE} AS build",
    "RUN echo first \\",
    "  && echo second",
    "CMD [\"node\", \"app.js\"]",
    ""
  ].join("\n"),
  "self-test valid"
));

assert.throws(
  () => validateDockerfile("RUN echo nope\n", "self-test missing FROM"),
  /only ARG may appear before the first FROM/
);
assert.throws(
  () => validateDockerfile("FRO node:22-alpine\n", "self-test unknown"),
  /unknown Dockerfile instruction/
);
const danglingContinuation =
  "FROM node:22-alpine " + String.fromCharCode(92) + "\n";
assert.throws(
  () => validateDockerfile(danglingContinuation, "self-test continuation"),
  /unterminated line continuation/
);
assert.throws(
  () => validateDockerfile("FROM node:22-alpine\nCMD [\"node\",]\n", "self-test JSON"),
  /invalid JSON form/
);

for (const file of dockerfiles) {
  validateDockerfile(fs.readFileSync(path.join(root, file), "utf8"), file);
}

console.log(`Dockerfile structure integrity passed for ${dockerfiles.length} tracked files`);
