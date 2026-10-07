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

const registrationWorkflow = read('.github/workflows/test-execution-registration.yml');
assert.doesNotMatch(
  registrationWorkflow,
  /^\s+paths:\s*(?:#.*)?$/m,
  'test execution registration workflow must remain always-on for PRs and pushes'
);

assert.ok(
  registrationWorkflow.includes('repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}'),
  'test execution registration workflow must checkout the PR-head repository'
);
assert.ok(
  registrationWorkflow.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'),
  'test execution registration workflow must checkout the PR-head SHA'
);
assert.ok(
  registrationWorkflow.includes('EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'),
  'test execution registration workflow must bind checkout verification to the selected SHA'
);
assert.ok(
  registrationWorkflow.includes('run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'),
  'test execution registration workflow must prove the checked-out git HEAD'
);

function workflowRunBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!match) continue;

    const indent = match[1].length;
    const inline = match[2].replace(/\s+#.*$/, '').trim();
    const blockScalar = /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(inline);

    if (inline && !blockScalar) {
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

const runBlockFixture = [
  'steps:',
  '  - run: node tests/inline.MJS',
  '  - run: |-',
  '      python tests/block.PY',
  '  - name: Named step',
  '    run: >+ # folded command',
  '      ruby tests/folded.RB',
].join('\n');
const extractedRunBlocks = workflowRunBlocks(runBlockFixture);
assert.match(extractedRunBlocks, /node tests\/inline\.MJS/, 'inline list-item run steps must be discovered');
assert.match(extractedRunBlocks, /python tests\/block\.PY/, 'literal block run steps with chomping indicators must be discovered');
assert.match(extractedRunBlocks, /ruby tests\/folded\.RB/, 'folded block run steps with comments must be discovered');

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
function isUniqueBasename(counts, basename) {
  return counts.get(basename) === 1;
}

function sourceExecutesTest(source, test, basename, uniqueBasename) {
  const references = uniqueBasename ? [test, basename] : [test];
  const lines = source.split(/\r?\n/);
  const childProcessCall = /\b(?:execFileSync|spawnSync|execSync|spawn)\s*\(/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
    if (!references.some((reference) => line.includes(reference))) continue;

    const window = lines
      .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
      .filter((candidate) => {
        const value = candidate.trim();
        return !value.startsWith('//') && !value.startsWith('#') && !value.startsWith('*');
      })
      .join(' ');

    if (childProcessCall.test(window)) return true;
  }

  return false;
}

assert.equal(
  sourceExecutesTest(
    "execFileSync(process.execPath, [path.join(__dirname, 'child.test.js')]);",
    'tests/child.test.js',
    'child.test.js',
    true
  ),
  true,
  'explicit child-process execution must register a nested test'
);
assert.equal(
  sourceExecutesTest(
    "const expected = 'node tests/child.test.js';",
    'tests/child.test.js',
    'child.test.js',
    true
  ),
  false,
  'a command-shaped assertion string must not register a nested test'
);
assert.equal(
  sourceExecutesTest(
    "// execFileSync(process.execPath, ['tests/child.test.js']);",
    'tests/child.test.js',
    'child.test.js',
    true
  ),
  false,
  'a commented-out child-process call must not register a nested test'
);

const basenameFixture = new Map([
  ['unique.test.mjs', 1],
  ['duplicate.test.mjs', 2],
]);
assert.equal(isUniqueBasename(basenameFixture, 'unique.test.mjs'), true, 'unique basenames may be used as registration aliases');
assert.equal(isUniqueBasename(basenameFixture, 'duplicate.test.mjs'), false, 'duplicate basenames must not be used as registration aliases');

const basenameCounts = new Map();
for (const test of tests) {
  const basename = path.basename(test);
  basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
}
const unregistered = [];

for (const test of tests) {
  const basename = path.basename(test);
  const directlyExecuted = executableCorpus.includes(test);
  const uniqueBasename = isUniqueBasename(basenameCounts, basename);

  const executedByAnotherTest = [...testSources.entries()].some(([other, source]) => (
    other !== test && sourceExecutesTest(source, test, basename, uniqueBasename)
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
