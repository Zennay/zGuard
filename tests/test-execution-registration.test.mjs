import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const trackedTestPath = /^tests\/.*\.(?:js|mjs|cjs|py|rb)$/i;
const trackedShellPath = /\.sh$/i;

assert.equal(trackedTestPath.test('tests/example.MJS'), true, 'test discovery must casefold extensions');
assert.equal(trackedTestPath.test('tests/example.PY'), true, 'Python test discovery must casefold extensions');
assert.equal(trackedTestPath.test('docs/example.MJS'), false, 'only the tests directory is executable-test scope');
assert.equal(trackedShellPath.test('scripts/validate.SH'), true, 'shell executor discovery must casefold extensions');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean);

const tests = tracked
  .filter((file) => trackedTestPath.test(file))
  .sort();

assert.ok(tests.length > 0, 'at least one tracked test file must be discovered');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function workflowRunBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/);
    if (!match) continue;

    const indent = match[1].length;
    const inline = match[2].trim();

    if (inline && inline !== '|' && inline !== '>') {
      blocks.push(inline);
      continue;
    }

    const body = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() === '') {
        body.push(line);
        continue;
      }

      const leading = line.match(/^\s*/)?.[0].length ?? 0;
      if (leading <= indent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }

  return blocks.join('\n');
}

const workflowCorpus = tracked
  .filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file))
  .map((file) => workflowRunBlocks(read(file)))
  .join('\n');

const shellCorpus = tracked
  .filter((file) => trackedShellPath.test(file))
  .map(read)
  .join('\n');

const packageCorpus = tracked
  .filter((file) => file.endsWith('package.json'))
  .flatMap((file) => Object.values(JSON.parse(read(file)).scripts ?? {}))
  .join('\n');

const executableCorpus = [workflowCorpus, shellCorpus, packageCorpus].join('\n');

const testSources = new Map(tests.map((file) => [file, read(file)]));
const unregistered = [];

for (const test of tests) {
  const basename = path.basename(test);
  const directlyExecuted = executableCorpus.includes(test);

  const executedByAnotherTest = [...testSources.entries()].some(([other, source]) => (
    other !== test && (source.includes(test) || source.includes(basename))
  ));

  if (!directlyExecuted && !executedByAnotherTest) {
    unregistered.push(test);
  }
}

assert.deepEqual(
  unregistered,
  [],
  `tracked tests must be wired into executable validation or another registered test:\n${unregistered.join('\n')}`
);

console.log(`Test execution registration contract passed for ${tests.length} tracked tests`);
