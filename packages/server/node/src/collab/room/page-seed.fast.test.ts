import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { historyLineages } from './history-lineages.ts';
import { seedUpdate } from './page-document.ts';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blok-page-seed-ledger-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const seed = () => newBaseline(seedUpdate({ blocks: [{ id: 'a', type: 'paragraph', data: { text: 'a' } }] }));

it('seeds at epoch 0, so the first reset is the first epoch a client ever sees', async () => {
  const baseline = seed();
  expect(baseline.epoch).toBe(0n);
  await initializePage(root, 'page', baseline, '{}', async () => {});
  const [entry] = await historyLineages(pageDirectory(root, 'page'));
  expect(entry?.manifest.epoch).toBe(0n);
});

it('records the seeded lineage in the ledger, so the baseline has a creation time', async () => {
  const before = Date.now();
  const baseline = seed();
  await initializePage(root, 'page', baseline, '{}', async () => {});
  const lineages = await historyLineages(pageDirectory(root, 'page'));
  expect(lineages).toHaveLength(1);
  expect(lineages[0]?.current).toBe(true);
  expect(lineages[0]?.manifest.lineage).toBe(Buffer.from(baseline.lineage).toString('hex'));
  // Null is "no ledger entry", and it is what keeps point 0 out of the time history.
  expect(lineages[0]?.createdAt).toBeGreaterThanOrEqual(before);
});
