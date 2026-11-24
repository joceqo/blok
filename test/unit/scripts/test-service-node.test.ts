// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runnerPath = resolve(repoRoot, 'scripts/test-service-node.mjs');
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

const runWithoutNpm = (
  args: string[],
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
    timeout: 15_000,
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('test-service-node runner', () => {
  it('refuses an unknown target', () => {
    const result = runWithoutNpm(['--target', 'go']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: node scripts/test-service-node.mjs');
  });

  it('announces the node target before spawning npm', () => {
    const result = runWithoutNpm(['--target', 'node']);

    expect(result.stdout).toContain('service-node: npm test in apps/service-node');
    expect(result.stderr).toMatch(/spawn(Sync)? npm ENOENT/);
  });

  it('documents the future Go oracle harness in the runner header', () => {
    expect(read('scripts/test-service-node.mjs')).toContain('test-service-conformance.mjs');
  });
});