import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';
import { inspectJournal } from './inspect.ts';

/** Rebuild the active lineage of an offline Go journal as a single Yjs v1 update. */
export async function replayJournal(directory: string): Promise<Uint8Array> {
  const doc = new Doc();
  try {
    const report = await inspectJournal(directory, ({ update }) => applyUpdate(doc, update));
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
