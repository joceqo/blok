#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { appendJournal, MAX_APPEND_BYTES } from '../dist/journal-append.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: blok-journal-append <seeded-directory> <lineage> <expected-through> <operation-id> <update.yjs>';
if (args.length === 1 && ['--help','-h'].includes(args[0])) {
  console.log(usage);
} else if (args.length !== 5 || !/^\d+$/.test(args[2])) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    const [directory, expectedLineage, through, operationId, path] = args;
    const file = await open(path, 'r');
    let update;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_APPEND_BYTES) throw new Error('Expected a 1 byte to 1 MiB Yjs update file');
      update = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < update.length) {
        const read = await file.read(update, offset, update.length - offset, offset);
        if (!read.bytesRead) throw new Error('Unexpected end of update file');
        offset += read.bytesRead;
      }
      if ((await file.stat()).size !== stat.size) throw new Error('Update file changed during read');
    } finally { await file.close(); }
    const result = await appendJournal(directory, {
      expectedLineage, expectedThrough:BigInt(through), operationId, source:0, actorId:null, update,
    });
    console.log(JSON.stringify({ outcome:result.outcome, sequence:String(result.sequence) }));
    if (result.outcome === 'conflict' || result.outcome === 'stale') process.exitCode = 3;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.code === 'JOURNAL_BUSY' ? 4 : 1;
  }
}
