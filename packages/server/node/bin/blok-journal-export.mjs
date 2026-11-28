#!/usr/bin/env node
import { replayJournal } from '../dist/journal-replay.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
  console.log('Usage: blok-journal-export <offline-journal-directory> > document.yjs');
} else if (args.length !== 1) {
  console.error('Expected one offline journal directory. Use --help for usage.');
  process.exitCode = 2;
} else {
  try {
    const update = await replayJournal(args[0]);
    await new Promise((resolve, reject) => {
      process.stdout.write(update, error => error ? reject(error) : resolve());
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
