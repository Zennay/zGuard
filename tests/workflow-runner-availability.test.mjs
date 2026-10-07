import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const workflowDir = path.join(root, '.github', 'workflows');

function normalizedLabel(value) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function genericSelfHostedRunsOn(source) {
  const findings = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)runs-on:\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;

    const indent = match[1].length;
    const rawValue = match[2].trim();

    if (/\$\{\{/.test(rawValue)) {
      findings.push(index + 1);
      continue;
    }

    if (normalizedLabel(rawValue) === 'self-hosted') {
      findings.push(index + 1);
      continue;
    }

    const inline = rawValue.match(/^\[(.*)\]$/);
    if (inline) {
      const labels = inline[1]
        .split(',')
        .map(normalizedLabel)
        .filter(Boolean);
      if (labels.length === 1 && labels[0] === 'self-hosted') findings.push(index + 1);
      continue;
    }

    if (rawValue !== '') continue;

    const labels = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate.trim() === '' || candidate.trim().startsWith('#')) continue;
      const candidateIndent = candidate.match(/^\s*/)[0].length;
      if (candidateIndent <= indent) break;
      const labelMatch = candidate.match(/^\s*-\s*(.*?)\s*(?:#.*)?$/);
      if (labelMatch) labels.push(normalizedLabel(labelMatch[1]));
    }
    if (labels.some((label) => /\$\{\{/.test(label))) {
      findings.push(index + 1);
      continue;
    }
    if (labels.length === 1 && labels[0] === 'self-hosted') findings.push(index + 1);
  }

  return findings;
}

const selfTests = [
  ['runs-on: self-hosted\n', true],
  ['runs-on: "self-hosted"\n', true],
  ['runs-on: [self-hosted]\n', true],
  ['runs-on:\n  - self-hosted\n', true],
  ['runs-on: [self-hosted, zcloud, vps]\n', false],
  ['runs-on:\n  - self-hosted\n  - zcloud\n  - vps\n', false],
  ['runs-on: ${{ matrix.runner }}\n', true],
  ['runs-on: [self-hosted, ${{ inputs.runner_label }}]\n', true],
  ['runs-on:\n  - ${{ matrix.runner }}\n', true],
  ['runs-on: ubuntu-latest\n', false],
];

for (const [fixture, shouldFail] of selfTests) {
  const failed = genericSelfHostedRunsOn(fixture).length > 0;
  if (failed !== shouldFail) {
    throw new Error(`Runner-availability detector self-test failed for: ${JSON.stringify(fixture)}`);
  }
}

const workflowFiles = fs
  .readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

if (workflowFiles.length === 0) {
  throw new Error('No GitHub Actions workflows found');
}

const violations = [];
for (const name of workflowFiles) {
  const relative = path.posix.join('.github', 'workflows', name);
  const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
  for (const line of genericSelfHostedRunsOn(source)) {
    violations.push(`${relative}:${line}`);
  }
}

if (violations.length > 0) {
  console.error('Generic or dynamic runner selection can queue indefinitely or bypass runner-label guarantees.');
  console.error('Use a literal hosted runner, or explicit self-hosted labels such as [self-hosted, zcloud, vps].');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Workflow runner availability contract passed for ${workflowFiles.length} workflows`);
