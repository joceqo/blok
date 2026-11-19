// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runnerPath = resolve(repoRoot, 'scripts/test-service-conformance.mjs');
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

const runRunner = (
  args: string[],
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
    timeout: 60_000,
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('test-service-conformance runner', () => {
  it('refuses an unknown target', () => {
    const result = runRunner(['--target', 'java']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: node scripts/test-service-conformance.mjs');
  });

  it('refuses an unknown suite', () => {
    const result = runRunner(['--target', 'node', '--suite', 'not-a-suite']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: node scripts/test-service-conformance.mjs');
  });

  it('refuses go with an oracle message, not usage', () => {
    const result = runRunner(['--target', 'go']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('oracle');
    expect(result.stderr).not.toContain('Usage:');
  });

  it('announces suites and runs vitest for the node target', () => {
    const result = runRunner(['--target', 'node']);

    expect(result.stdout).toContain('Service conformance suites:');
    expect(result.stdout).toContain('service conformance: vitest in test/unit/service-conformance');
    expect(result.stderr).not.toContain('Usage:');
  });

  it('documents BLOK_SERVICE_CONFORMANCE_URL in the runner', () => {
    expect(read('scripts/test-service-conformance.mjs')).toContain('BLOK_SERVICE_CONFORMANCE_URL');
  });
});