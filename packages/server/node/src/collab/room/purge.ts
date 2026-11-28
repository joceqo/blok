import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { acquireJournalLock } from '../journal/append.ts';
import { pageDirectory, syncDirectory } from './page-seed.ts';

/** The shell tombstones the canonical page before asking the host to erase its journal. */
export async function purgeDocument(directory: string, projected: boolean) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(directory));
  const hold = await acquireJournalLock(directory);
  try {
    const marker = await open(
      join(directory, 'purged'),
      constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await marker.sync();
    } finally {
      await marker.close();
    }
    // A failed unlink must leave a durable tombstone. Repeating the purge resumes cleanup.
    await syncDirectory(directory);
    for (const name of await readdir(directory)) {
      if (name !== 'lock' && name !== 'purged') await unlink(join(directory, name));
    }
    await syncDirectory(directory);
    if (projected) {
      const root = dirname(directory);
      const key = basename(directory, '.journal');
      const siblings = await readdir(root, { withFileTypes: true });
      if (siblings.some((entry) => !entry.isDirectory() && /^\.blok-collab-[a-f\d]{32}$/i.test(entry.name)))
        throw new Error('An unkeyed legacy temporary may contain document data');
      for (const entry of siblings) {
        if (!entry.isDirectory() || !entry.name.startsWith('.seed-')) continue;
        const path = join(root, entry.name);
        if (entry.name.startsWith('.seed-' + key + '-')) {
          await rm(path, { recursive: true, force: true });
        } else if (/^\.seed-[a-zA-Z0-9]{6}$/.test(entry.name)) {
          // Before staging directories were document-scoped, only the anchor
          // recorded their owner. Ambiguous bytes cannot be reported as erased.
          const owner = JSON.parse(await readFile(join(path, 'node-projection.json'), 'utf8')).pageId;
          if (typeof owner !== 'string' || !owner) throw new Error('Unidentified staged document');
          if (pageDirectory(root, owner) === directory) await rm(path, { recursive: true, force: true });
        }
      }
      for (const { name } of siblings) {
        if (
          name === key ||
          name.startsWith(key + '.unreadable-') ||
          name.startsWith('.blok-collab-' + key + '-')
        )
          await unlink(join(root, name));
      }
      await syncDirectory(root);
    }
  } finally {
    await hold.close();
  }
}
