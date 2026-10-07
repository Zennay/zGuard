import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findingsFromIndex(records) {
  const findings = [];

  for (const record of records) {
    if (!record) continue;

    const tab = record.indexOf('\t');
    assert.notEqual(tab, -1, `unexpected git ls-files record: ${JSON.stringify(record)}`);

    const metadata = record.slice(0, tab).split(' ');
    const relative = record.slice(tab + 1);
    const mode = metadata[0];
    const base = path.posix.basename(relative.replaceAll('\\\\', '/'));

    if (mode === '160000') {
      findings.push(`${relative}: tracked gitlink/submodule entry`);
      continue;
    }

    if (base.toLowerCase() === '.gitmodules') {
      findings.push(`${relative}: tracked .gitmodules metadata`);
    }
  }

  return findings;
}

assert.deepEqual(
  findingsFromIndex([
    '100644 deadbeef 0\tREADME.md',
    '100755 deadbeef 0\tscripts/check.sh'
  ]),
  [],
  'ordinary files must remain allowed'
);

assert.deepEqual(
  findingsFromIndex(['160000 deadbeef 0\tvendor/dependency']),
  ['vendor/dependency: tracked gitlink/submodule entry'],
  'gitlinks must be rejected'
);

assert.deepEqual(
  findingsFromIndex(['100644 deadbeef 0\tconfig/.GITMODULES']),
  ['config/.GITMODULES: tracked .gitmodules metadata'],
  'case-variant .gitmodules files must be rejected'
);

const records = execFileSync('git', ['ls-files', '-s', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0');

const findings = findingsFromIndex(records);

assert.deepEqual(
  findings,
  [],
  [
    'repository must not track Git submodules or .gitmodules metadata',
    ...findings.map((finding) => `- ${finding}`),
    'Vendor reviewed source directly or fetch immutable dependencies in a controlled build step instead.'
  ].join('\n')
);

console.log('Repository submodule hygiene contract passed');
