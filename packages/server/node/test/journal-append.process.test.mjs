import assert from 'node:assert/strict';
import { execFile, fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { inspectJournal } from '../dist/journal-inspect.mjs';

const run = promisify(execFile);
const exporter = fileURLToPath(new URL('../bin/blok-journal-export.mjs', import.meta.url));
async function replayJournal(directory) {
  const { stdout } = await run(process.execPath, [exporter, directory], { encoding: 'buffer' });
  return stdout;
}

const worker = new URL('./support/append-worker.mjs', import.meta.url);
const fixture = new URL('./fixtures/go-journal/', import.meta.url);
const goModule = fileURLToPath(new URL('../../go/', import.meta.url));
const lineage = '00112233445566778899aabbccddeeff';

async function copyFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'blok-journal-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docKey = createHash('sha256').update('inspect-example').digest('hex');
  const directory = join(root, docKey + '.journal');
  await cp(fixture, directory, { recursive: true });
  return directory;
}

function request(n, value) {
  const doc = new Doc();
  doc.clientID = 10000 + n;
  doc.getMap('process').set(String(n), value);
  const update = encodeStateAsUpdate(doc);
  doc.destroy();
  return {
    expectedLineage: lineage, expectedThrough: 3n, operationId: n.toString(16).padStart(32, '0'),
    actorId: 'process-test', source: 0, update,
  };
}

async function readyWriter(t) {
  const child = fork(worker, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  function nextMessage() {
    return Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code, signal]) => { throw Error(`Writer exited: code=${code}, signal=${signal}`); }),
    ]);
  }
  assert.equal(await nextMessage(), 'ready');
  return {
    async send(directory, command) {
      const result = nextMessage();
      child.send({ directory, request: command });
      return result;
    },
    async stop(signal) {
      if (signal) child.kill(signal);
      else child.disconnect();
      await exited;
    },
  };
}

async function submit(t, directory, command) {
  const writer = await readyWriter(t);
  const result = await writer.send(directory, command);
  await writer.stop();
  return result;
}

async function assertReplay(directory, updates) {
  const actual = new Doc();
  const expected = new Doc();
  try {
    applyUpdate(expected, await replayJournal(fileURLToPath(fixture)));
    for (const update of updates) applyUpdate(expected, update);
    applyUpdate(actual, await replayJournal(directory));
    assert.equal(actual.getText('text').toString(), 'start-1-2-3');
    assert.deepEqual(actual.getMap('process').toJSON(), expected.getMap('process').toJSON());
    assert.deepEqual(encodeStateVector(actual), encodeStateVector(expected));
  } finally {
    actual.destroy();
    expected.destroy();
  }
}

test('an acknowledged commit survives a SIGKILL and retries in a new process', async t => {
  const directory = await copyFixture(t);
  const command = request(10, 'saved');
  const first = await readyWriter(t);
  assert.deepEqual(await first.send(directory, command), { outcome: 'committed', sequence: 4n });
  await first.stop('SIGKILL');

  assert.deepEqual(await submit(t, directory, command), { outcome: 'duplicate', sequence: 4n });
  const changed = { ...command, update: request(11, 'different').update };
  assert.deepEqual(await submit(t, directory, changed), { outcome: 'conflict', sequence: 4n });
  const report = await inspectJournal(directory);
  assert.equal(report.integrity, 'ok');
  assert.equal(report.journal.durableThrough, 4n);
  await assertReplay(directory, [command.update]);
});

test('two independent writers with the same head yield exactly one new sequence', async t => {
  const directory = await copyFixture(t);
  const commands = [request(12, 'left'), request(13, 'right')];
  const writers = await Promise.all(commands.map(() => readyWriter(t)));
  const answers = await Promise.all(writers.map((writer, i) => writer.send(directory, commands[i])));
  await Promise.all(writers.map(writer => writer.stop()));
  const winners = answers.flatMap((answer, i) => answer.outcome === 'committed' ? [i] : []);
  assert.equal(winners.length, 1, JSON.stringify(answers, (_, v) => typeof v === 'bigint' ? String(v) : v));
  const winner = winners[0], loser = 1 - winner;
  assert.equal(answers[winner].sequence, 4n);
  assert.ok(answers[loser].outcome === 'stale' || answers[loser].code === 'JOURNAL_BUSY');
  assert.deepEqual(await submit(t, directory, commands[loser]), { outcome: 'stale', sequence: 4n });
  assert.deepEqual(await submit(t, directory, { ...commands[loser], expectedThrough: 4n }),
    { outcome: 'committed', sequence: 5n });
  await assertReplay(directory, [commands[winner].update, commands[loser].update]);
});

test('recovery truncates an incomplete final record and preserves the confirmed prefix', async t => {
  const directory = await copyFixture(t);
  const journal = join(directory, 'journal.1.1');
  const original = await readFile(journal);
  const lost = request(14, 'interrupted');
  assert.equal((await submit(t, directory, lost)).outcome, 'committed');
  // Use bytes of an actual encoded record, cut inside its body as after a torn write.
  const published = await readFile(journal);
  await truncate(journal, published.length - 1);
  const report = await inspectJournal(directory);
  assert.equal(report.integrity, 'incomplete');
  assert.equal(report.journal.durableThrough, 3n);
  const recovered = request(15, 'replacement');
  assert.deepEqual(await submit(t, directory, recovered), { outcome: 'committed', sequence: 4n });
  assert.deepEqual((await readFile(journal)).subarray(0, original.length), original);
  await assertReplay(directory, [recovered.update]);
});

test('a bad checksum inside a complete record is never repaired as a torn tail', async t => {
  const directory = await copyFixture(t);
  const journal = join(directory, 'journal.1.1');
  const damaged = await readFile(journal);
  damaged[damaged.length - 1] ^= 1;
  await writeFile(journal, damaged);
  const result = await submit(t, directory, request(16, 'must not land'));
  assert.ok(result.error, 'a complete invalid record must stop appends');
  assert.deepEqual(await readFile(journal), damaged);
  assert.equal((await inspectJournal(directory)).integrity, 'corrupt');
});

async function openGoSession(t, directory) {
  const program = process.env.BLOK_TEST_GO_JOURNAL_HOLDER;
  const child = program
    ? spawn(program, [dirname(directory)], { stdio: ['pipe','pipe','inherit'] })
    : spawn('go', ['run', './internal/collab/journal/testdata/hold-open', dirname(directory)], {
        cwd: goModule, stdio: ['pipe','pipe','inherit'],
      });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; });
  const lines = createInterface({ input: child.stdout });
  const ready = await Promise.race([
    once(lines, 'line').then(([line]) => BigInt(line)),
    exited.then(([code]) => { throw Error(`Go exited before opening the journal: ${code}`); }),
  ]);
  return { ready, async close() { child.stdin.end(); assert.deepEqual(await exited, [0,null]); } };
}

async function contents(directory) {
  return Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name))]));
}

test('a live Go session excludes Node, then Go opens the state committed by Node', async t => {
  const directory = await copyFixture(t);
  const go = await openGoSession(t, directory);
  assert.equal(go.ready, 3n);
  const unchanged = await contents(directory);
  const command = request(17, 'between Go sessions');
  assert.equal((await submit(t, directory, command)).code, 'JOURNAL_BUSY');
  assert.deepEqual(await contents(directory), unchanged);
  await go.close();
  assert.deepEqual(await submit(t, directory, command), { outcome: 'committed', sequence: 4n });
  const reopened = await openGoSession(t, directory);
  assert.equal(reopened.ready, 4n);
  await reopened.close();
  await assertReplay(directory, [command.update]);
});
