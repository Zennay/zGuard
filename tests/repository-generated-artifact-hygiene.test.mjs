import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8'
}).split('\0').filter(Boolean).sort();

assert.ok(tracked.length > 0, 'repository must contain tracked files');

const forbiddenDirectories = new Set([
  'node_modules',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  '__pycache__'
]);

const forbiddenBasenames = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'npm-debug.log',
  'yarn-error.log',
  'pnpm-debug.log'
]);

const transientSuffix = /(?:\.swp|\.swo|\.tmp|\.bak|\.orig|\.rej|~)$/i;
const findings = [];

for (const relative of tracked) {
  const normalized = relative.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const base = segments.at(-1);

  const generatedSegment = segments.find((segment) => forbiddenDirectories.has(segment));
  if (generatedSegment) {
    findings.push(`${relative}: generated directory "${generatedSegment}"`);
    continue;
  }

  if (forbiddenBasenames.has(base)) {
    findings.push(`${relative}: generated/OS artifact "${base}"`);
    continue;
  }

  if (transientSuffix.test(base)) {
    findings.push(`${relative}: transient editor/build artifact`);
  }
}

assert.deepEqual(
  findings,
  [],
  [
    'tracked repository paths must stay free of generated/transient artifacts',
    ...findings.map((finding) => `- ${finding}`),
    'Keep generated output, caches, logs and editor/OS temporary files outside git.'
  ].join('\n')
);

console.log(
  `Repository generated-artifact hygiene contract passed for ${tracked.length} tracked files`
);
