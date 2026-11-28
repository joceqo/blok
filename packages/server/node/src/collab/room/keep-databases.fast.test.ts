import { readFileSync } from 'node:fs';
import { applyUpdate, Doc } from 'yjs';
import { expect, it } from 'vitest';
import { keepDatabases } from './keep-databases.ts';
import { exportPage } from './page-document.ts';
import type { OutputData } from '../../../../../../types/data-formats/output-data.ts';

interface Fixture {
  name: string;
  databases: string;
  current: string;
  target: string;
  kept: string[];
  orphaned: { blockId: string }[];
}
const { cases } = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../../test/unit/server-conformance/fixtures/collab-history/restore-scope.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: Fixture[] };
function page(bytes: string) {
  const d = new Doc();
  try {
    applyUpdate(d, Buffer.from(bytes, 'base64'));
    return exportPage(d, {}) as unknown as OutputData;
  } finally {
    d.destroy();
  }
}
it.each(cases.filter((c) => c.databases === 'keep'))(
  'uses the shared database-preserving restore fixture: $name',
  (c) => {
    const live = page(c.current),
      target = page(c.target);
    const result = keepDatabases(live, target);
    expect(
      live.blocks
        .filter((b) => result.pinned.has(b.id!))
        .map((b) => b.id)
        .sort(),
    ).toEqual(c.kept);
    expect(result.orphans).toEqual(c.orphaned.map((g) => g.blockId));
    for (const id of c.kept) {
      const block = result.blocks.find((b) => b.id === id)!;
      const current = live.blocks.find((b) => b.id === id)!;
      expect(block.data).toEqual(current.data);
      expect(block.type).toEqual(current.type);
    }
  },
);
