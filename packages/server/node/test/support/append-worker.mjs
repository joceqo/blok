// Each test submission runs against the published bundle in a fresh Node process.
import { appendJournal } from '../../dist/journal-append.mjs';

process.send('ready');
process.once('message', async ({ directory, request }) => {
  try {
    const result = await appendJournal(directory, request);
    process.send(result);
  } catch (error) {
    process.send({ error: error.message, code: error.code });
  }
});
// The parent can kill an acknowledged process before it exits normally.
process.on('message', () => {});
