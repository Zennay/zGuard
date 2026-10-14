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

// A filename in a comment, echo, syntax-check or documentation string is not
// evidence that CI executes the test. Inspect command positions, not substrings.
function shellExecutesTest(corpus, test) {
  for (const line of corpus.split(/\r?\n/)) {
    if (/^\s*(?:#|\/\/)/.test(line)) continue;
    for (const fragment of line.split(/&&|\|\||[;|]/)) {
      let command = fragment.trim().replace(/^(?:(?:do|then)\s+)?/, '');
      command = command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, '');
      command = command.replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, '');
      const words = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
      const executable = words[0];
      if (!/^(?:node|nodejs|python|python2|python3|ruby|pytest)$/.test(executable)) continue;
      // Syntax-only compilation and inline eval do not run a test module.
      if ((/^(?:node|nodejs)$/.test(executable) &&
           /^(?:--check|-c|--eval|-e)$/.test(words[1] ?? '')) ||
          (/^python/.test(executable) && (words[1] === '-c' ||
            (words[1] === '-m' && words[2] === 'py_compile'))) ||
          (executable === 'ruby' && words[1] === '-c')) continue;
      if (words.slice(1).some((word) => word.includes(test))) return true;
    }
  }
  return false;
}
for (const [script, expected] of [
  ['node tests/child.test.js', true],
  ['node ../tests/child.test.js', true],
  ['node --test tests/child.test.js', true],
  ['node --check tests/child.test.js', false],
  ["node -e \"console.log(\'tests/child.test.js\')\"", false],
  ['python3 -m py_compile tests/child.test.js', false],
  ['ruby -c tests/child.test.js', false],
  ['echo node tests/child.test.js', false],
  ['# node tests/child.test.js', false],
  ['echo "tests/child.test.js"', false],
  ['some_other_command tests/child.test.js', false],
  ['cd tests && node ../tests/child.test.js', true]
]) {
  assert.equal(shellExecutesTest(script, 'tests/child.test.js'), expected,
    script + ': registration requires real test execution');
}

const testSources = new Map(tests.map((file) => [file, read(file)]));
function isUniqueBasename(counts, basename) {
  return counts.get(basename) === 1;
}

// Preserve original positions but mask comments, and optionally string bodies.
// This lets us find actual JS child-process invocations while keeping their
// quoted test path arguments visible for registration.
function maskedSource(source, maskStrings) {
  const result = source.split('');
  let state = 'code';
  let quote = '';
  let escaped = false;
  const blank = (index) => {
    if (source[index] !== '\n' && source[index] !== '\r') result[index] = ' ';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n' || char === '\r') state = 'code';
      else blank(index);
      continue;
    }
    if (state === 'block') {
      blank(index);
      if (char === '*' && next === '/') {
        blank(index + 1);
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      if (maskStrings) blank(index);
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        state = 'code';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      blank(index);
      blank(index + 1);
      index += 1;
      state = 'line';
      continue;
    }
    if (char === '/' && next === '*') {
      blank(index);
      blank(index + 1);
      index += 1;
      state = 'block';
      continue;
    }
    if (char === "'" || char === '"' || char === String.fromCharCode(96)) {
      quote = char;
      state = 'string';
      if (maskStrings) blank(index);
    }
  }
  return result.join('');
}

// Cache executable invocation arguments once per source, not once per test.
// A nearby comment or unrelated string literal can never claim execution.
const invocationCache = new Map();
function executableInvocations(source) {
  if (invocationCache.has(source)) return invocationCache.get(source);
  const code = maskedSource(source, true);
  const argumentsSource = maskedSource(source, false);
  const calls = [];
  const matcher = /\b(?:execFileSync|spawnSync|execSync|spawn)\s*\(/g;
  for (const match of code.matchAll(matcher)) {
    let depth = 1;
    for (let index = match.index + match[0].length; index < code.length; index += 1) {
      if (code[index] === '(') depth += 1;
      else if (code[index] === ')') depth -= 1;
      if (depth === 0) {
        calls.push(argumentsSource.slice(match.index, index + 1));
        break;
      }
    }
  }
  invocationCache.set(source, calls);
  return calls;
}
// A child process naming a test in an unrelated argument (for example
// `git show tests/example.test.js`) does not execute that test. Require an
// actual language/test runner; unknown dynamic executables cannot prove CI
// registration. Shell commands must also pass the existing command parser.
function sourceExecutesTest(source, test, basename, uniqueBasename) {
  const references = uniqueBasename ? [test, basename] : [test];
  return executableInvocations(source).some((call) => {
    const invocation = call.match(
      /^(execFileSync|spawnSync|execSync|spawn)\s*\(\s*(process\.execPath|(["'])(.*?)\3)/s
    );
    if (!invocation) return false;
    const executable = invocation[2] === 'process.execPath'
      ? 'node'
      : invocation[4].trim();
    if (!/^(?:node(?:js)?|python(?:2|3)?|ruby|pytest)(?:\s|$)/.test(executable)) {
      return false;
    }
    if (invocation[1] === 'execSync') {
      return references.some((reference) => shellExecutesTest(executable, reference));
    }
    if (!/^(?:node(?:js)?|python(?:2|3)?|ruby|pytest)$/.test(executable)) {
      return false;
    }
    // Syntax-check and inline-evaluation paths only parse source; even when
    // the target path is provided, these are not proof of running its tests.
    if (/\[\s*["'](?:--check|-c|--eval|-e)["']\s*(?:,|\])/.test(call)) return false;
    return references.some((reference) => call.includes(reference));
  });
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
for (const nonRunner of [
  "execFileSync('git', ['show', 'tests/child.test.js']);",
  "spawnSync('grep', ['-R', 'tests/child.test.js', '.']);",
  "execSync('git show tests/child.test.js');",
  "spawnSync(process.execPath, ['--check', 'tests/child.test.js']);",
  "spawnSync('node', ['--eval', 'console.log(\\\"tests/child.test.js\\\")']);",
  "execSync('node --check tests/child.test.js');",
  "execFileSync('node -e', ['tests/child.test.js']);"
]) {
  assert.equal(sourceExecutesTest(nonRunner,
    'tests/child.test.js', 'child.test.js', true), false,
    'mentioning a test in a non-execution process is not registration');
}
for (const realRunner of [
  "spawnSync('node', ['tests/child.test.js']);",
  "execFileSync(process.execPath, ['tests/child.test.js']);",
  "execSync('node tests/child.test.js');"
]) {
  assert.equal(sourceExecutesTest(realRunner,
    'tests/child.test.js', 'child.test.js', true), true,
    'real test runner execution must still register its target');
}

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

// Comments, documentation strings and adjacent non-execution text must not
// register an orphaned test by accidentally looking like a process invocation.
for (const nonExecution of [
  "/*\nexecFileSync(process.execPath, ['tests/child.test.js']);\n*/",
  "const note = \"execFileSync(process.execPath, ['tests/child.test.js']);\";",
  "execFileSync('git', ['status']);\nconst note = 'tests/child.test.js';",
  "execFileSync('git', ['status']); // tests/child.test.js",
  "/* ignored */ const note = 'tests/child.test.js';",
  "const url = 'https://example.test'; // execFileSync('node',['tests/child.test.js'])"
]) {
  assert.equal(sourceExecutesTest(nonExecution, 'tests/child.test.js', 'child.test.js', true), false,
    'only executable child-process call arguments may register a test');
}
assert.equal(sourceExecutesTest(
  "execFileSync(\n  process.execPath,\n  [path.join(__dirname, 'child.test.js')]\n);",
  'tests/child.test.js', 'child.test.js', true
), true, 'nested multiline executable call arguments must register');
assert.equal(sourceExecutesTest(
  "/* misleading */ execFileSync(process.execPath, ['tests/child.test.js']);",
  'tests/child.test.js', 'child.test.js', true
), true, 'a real call after a completed block comment must register');

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
  const directlyExecuted = shellExecutesTest(executableCorpus, test);
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
