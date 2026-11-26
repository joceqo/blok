import { basename, join, resolve } from 'node:path';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';
import { checkpointReadable } from './checkpoint.ts';
import { MANIFEST_FILE_NAME, readManifest } from './files.ts';
import { inspectJournal } from './inspect.ts';

/** Rebuild the active lineage of an offline Go journal as a single Yjs v1 update. */
export async function replayJournal(directory: string): Promise<Uint8Array> {
  const root = resolve(directory);
  const doc = new Doc();
  try {
    // A checkpoint only compacts the replay. When it cannot be read back, the
    // baseline and the whole journal still describe the same document.
    const head = await readManifest(join(root, MANIFEST_FILE_NAME), basename(root));
    const fromBaseline = !!head && !(await checkpointReadable(root, head, basename(root)));
    const report = await inspectJournal(root, ({ update }) => applyUpdate(doc, update), undefined, fromBaseline);
    if (report.integrity !== 'ok' || report.state !== 'seeded') {
      throw new Error(`Cannot export journal (state=${report.state}, integrity=${report.integrity})`);
    }
    // Match the room's checkpoint rule: Yjs can accept and park a change
    // whose causal dependencies are still missing after the last record.
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
      throw new Error('Journal ended with unresolved Yjs dependencies');
    }
    return encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
