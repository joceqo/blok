import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_MAGIC, CHECKPOINT_MAGIC, InvalidDataError, MANIFEST_FILE_NAME,
  baselineName, checkpointName, journalName, readManifest, readSealed, type JournalManifest,
} from './files.ts';

type WireManifest = { [K in keyof JournalManifest]: JournalManifest[K] extends bigint ? string : JournalManifest[K] };
type Magic = typeof BASELINE_MAGIC | typeof CHECKPOINT_MAGIC;
type SealedBytes = { magic: Magic; tag: string; content: string; hex: string };
interface Fixtures {
  manifest: {
    encode: (WireManifest & { hex: string })[];
    read: { name: string; hex: string; manifest?: WireManifest | null; error?: string }[];
  };
  sealed: {
    encode: SealedBytes[];
    read: { name: string; fileName: string; magic: Magic; hex: string | null; tag?: string; content?: string; error?: string }[];
  };
}

const fixtureURL = new URL('../../../../../../test/unit/server-conformance/fixtures/collab-disk/codecs.json', import.meta.url);
const fixture: Fixtures = JSON.parse(await readFile(fixtureURL, 'utf8'));

function expected(m: WireManifest): JournalManifest {
  return {
    seeded: m.seeded, format: m.format, lineage: m.lineage,
    writeCounter: BigInt(m.writeCounter), fence: BigInt(m.fence), generation: BigInt(m.generation),
    epoch: BigInt(m.epoch), checkpointThrough: BigInt(m.checkpointThrough),
    generationFence: BigInt(m.generationFence), checkpointFence: BigInt(m.checkpointFence),
  };
}

describe('offline Go/.NET journal files', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'blok-journal-files-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each(fixture.manifest.read)('reads the manifest fixture "$name"', async test => {
    const path = join(directory, MANIFEST_FILE_NAME);
    await writeFile(path, Buffer.from(test.hex, 'hex'));
    const result = readManifest(path, 'doc-1');
    if (test.error) await expect(result).rejects.toMatchObject({ name: 'InvalidDataError', message: test.error });
    else expect(await result).toEqual(test.manifest ? expected(test.manifest) : null);
  });

  it.each(fixture.manifest.encode)('decodes all fields of write counter $writeCounter', async test => {
    const path = join(directory, MANIFEST_FILE_NAME);
    await writeFile(path, Buffer.concat([Buffer.from(test.hex, 'hex'), Buffer.alloc(128)]));
    expect(await readManifest(path, 'doc-1')).toEqual(expected(test));
  });

  it('recognizes an unpublished directory without creating its manifest', async () => {
    const path = join(directory, MANIFEST_FILE_NAME);
    expect(await readManifest(path, 'doc-1')).toBeNull();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(fixture.sealed.read)('reads the sealed fixture "$name"', async test => {
    const path = join(directory, test.fileName);
    if (test.hex !== null) await writeFile(path, Buffer.from(test.hex, 'hex'));
    const result = readSealed(path, test.magic, 'doc-1');
    if (test.error) {
      await expect(result).rejects.toMatchObject({ name: 'InvalidDataError', message: test.error });
    } else {
      const { tag, content } = await result;
      expect(tag.toString()).toBe(test.tag);
      expect(content.toString('hex')).toBe(test.content);
    }
  });

  it.each(fixture.sealed.encode)('decodes published $magic bytes and tag $tag', async test => {
    const path = join(directory, 'fixture');
    await writeFile(path, Buffer.from(test.hex, 'hex'));
    const { content, tag } = await readSealed(path, test.magic, 'doc-1');
    expect(tag).toBe(BigInt(test.tag));
    expect(content.toString('hex')).toBe(test.content);
  });

  it('retains the missing sealed file as the cause and returns other filesystem errors unchanged', async () => {
    const error = await readSealed(join(directory, 'absent'), BASELINE_MAGIC, 'doc-1').catch(error => error);
    expect(error).toBeInstanceOf(InvalidDataError);
    expect(error.cause).toMatchObject({ code: 'ENOENT' });
    const file = join(directory, 'file');
    await writeFile(file, '');
    await expect(readManifest(join(file, 'manifest'), 'doc-1')).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(readSealed(join(file, 'baseline'), BASELINE_MAGIC, 'doc-1')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('names published files with decimal 64-bit values', () => {
    const fence = 18446744073709551615n;
    expect(baselineName(2n, fence)).toBe('baseline.2.18446744073709551615');
    expect(journalName(2n, fence)).toBe('journal.2.18446744073709551615');
    expect(checkpointName(2n, 9n, fence)).toBe('checkpoint.2.9.18446744073709551615');
  });
});
