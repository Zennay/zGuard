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

const isDockerfilePath = (file) => {
  const base = path.basename(file).toLowerCase();
  return base === "dockerfile" || base.startsWith("dockerfile.");
};

const dockerfiles = tracked.filter(isDockerfilePath).sort();

assert.ok(dockerfiles.length > 0, "repository must contain tracked Dockerfiles");
assert.equal(isDockerfilePath("Dockerfile"), true, "Dockerfile discovery must accept the canonical name");
assert.equal(isDockerfilePath("dockerfile"), true, "Dockerfile discovery must be case-insensitive");
assert.equal(isDockerfilePath("images/DOCKERFILE.prod"), true, "Dockerfile discovery must accept case-variant suffixes");
assert.equal(isDockerfilePath("images/MyDockerfile"), false, "Dockerfile discovery must reject unrelated basenames");

const instructions = new Set([
  "ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM",
  "HEALTHCHECK", "LABEL", "MAINTAINER", "ONBUILD", "RUN", "SHELL",
  "STOPSIGNAL", "USER", "VOLUME", "WORKDIR"
]);

const jsonInstructions = new Set([
  "ADD", "CMD", "COPY", "ENTRYPOINT", "RUN", "SHELL", "VOLUME"
]);

const singletonStageInstructions = new Set([
  "CMD", "ENTRYPOINT", "HEALTHCHECK", "STOPSIGNAL"
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
  let stageSingletons = new Set();

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
      stageSingletons = new Set();
    } else if (singletonStageInstructions.has(instruction)) {
      assert.ok(
        !stageSingletons.has(instruction),
        `${label}: ${instruction} appears more than once in the same build stage; Docker keeps only the last declaration`
      );
      stageSingletons.add(instruction);
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

assert.doesNotThrow(() => validateDockerfile(
  [
    "FROM node:22-alpine AS build",
    "CMD [\"node\", \"build.js\"]",
    "FROM node:22-alpine AS runtime",
    "CMD [\"node\", \"server.js\"]",
    ""
  ].join("\n"),
  "self-test multi-stage"
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
assert.throws(
  () => validateDockerfile(
    [
      "FROM node:22-alpine",
      "CMD [\"node\", \"first.js\"]",
      "CMD [\"node\", \"second.js\"]",
      ""
    ].join("\n"),
    "self-test shadowed CMD"
  ),
  /CMD appears more than once in the same build stage/
);

for (const file of dockerfiles) {
  validateDockerfile(fs.readFileSync(path.join(root, file), "utf8"), file);
}

const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/repository-dockerfile-structure.yml"),
  "utf8"
);
assert.doesNotMatch(
  workflow,
  /^\s+paths:\s*$/m,
  "Dockerfile structure workflow must run on every PR/push so filename casing cannot bypass validation"
);

console.log(`Dockerfile structure integrity passed for ${dockerfiles.length} tracked files`);
