#!/usr/bin/env node
import { inspectJournal } from '../dist/journal-inspect.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: npm run journal:inspect -- <stopped-journal-directory>\nInspect the active generation of a stopped local document journal or a coherent offline copy.';
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(usage);
} else if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const result = await inspectJournal(args[0]);
  console.log(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  process.exitCode = result.integrity === 'ok' ? 0 : 1;
}
