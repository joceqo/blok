// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const runnerPath = resolve(repoRoot, 'scripts/test-service-conformance.mjs');
const serviceNodeRunnerPath = resolve(repoRoot, 'scripts/test-service-node.mjs');
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

type RunnerResult = { status: number | null; stdout: string; stderr: string };

/**
 * With no PATH the vitest spawn still runs (node execPath), but a runner that
 * also shells out to npm for the package must surface npm ENOENT instead of usage.
 */
const runRunner = (args: string[]): RunnerResult => {
  const result = spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
    timeout: 60_000,
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('service conformance runner law', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the conformance runner at the repo root', () => {
    expect(read('scripts/test-service-conformance.mjs')).toContain('test/unit/service-conformance');
  });

  it('refuses an unknown target', () => {
    const result = runRunner(['--target', 'csharp']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: node scripts/test-service-conformance.mjs');
  });

  it('refuses go until the oracle harness exists', () => {
    const result = runRunner(['--target', 'go']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('oracle');
    expect(result.stderr).not.toContain('Usage:');
  });

  it('announces the node target before spawning npm in test-service-node', () => {
    const result = spawnSync(process.execPath, [serviceNodeRunnerPath, '--target', 'node'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
      timeout: 15_000,
    });

    expect(result.stdout).toContain('service-node: npm test in apps/service-node');
    expect(result.stderr).toMatch(/spawn(Sync)? npm ENOENT/);
  });

  it('lets the conformance runner accept --target node', () => {
    const result = runRunner(['--target', 'node']);

    expect(result.stderr).not.toContain('Usage:');
    expect(result.stdout).toContain('service conformance: vitest in test/unit/service-conformance');
  });

  it('forwards BLOK_SERVICE_CONFORMANCE_URL to the suite driver', () => {
    expect(read('scripts/test-service-conformance.mjs')).toContain('BLOK_SERVICE_CONFORMANCE_URL');
  });
});