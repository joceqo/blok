# `@bloklabs/server-node`

Fourth Blok server host implementation: HTTP/1.1 on `node:net` with Kestrel wire behaviour (not `node:http`), measured against the shared conformance fixtures.

**Not published** (`private: true`), same as Rust before it ships.

## Build

```bash
node scripts/build-node-server.mjs
```

Produces `packages/server/node/dist/blok-server` (ordinary) and `dist/blok-server-conformance` (`BLOK_CONFORMANCE=true`).

## Inspect a stopped journal

Build once from the repository root, then pass the document journal directory containing `manifest`. Use a stopped writer or a coherent offline copy. The inspector opens files read-only and acquires no lock.

```bash
node scripts/build-node-server.mjs
npm --prefix packages/server/node run --silent journal:inspect -- /absolute/path/to/document.journal
```

The JSON report includes all published manifest fields, the active baseline and checkpoint, the byte count verified, the contiguous sequence range and the number of records after the checkpoint. It checks slot and envelope checksums, baseline frame lengths, per-record checksums, unique operation IDs, sequence continuity and the checkpoint boundary. All 64-bit values are decimal strings. Document updates are opaque to this command.

An incomplete final record is reported with its verified prefix. The CLI exits with 0 for a verified generation or a recognized purged/unseeded state, 1 for an inspection problem, and 2 for invalid arguments.

## Test

**Fast (in-process, Vitest + Zod 4)** — low memory, for routes and CLI parse:

```bash
cd packages/server/node && npm install && npm test
```

**Slow (conformance, spawn)** — parity with Go/C#/Rust:

```bash
node scripts/build-node-server.mjs
node scripts/test-server-conformance.mjs --target node
```

Filter one suite: `--suite routing-contract`. Files named `*.fast.test.ts` are the fast tier only.

## Export a closed journal as a Yjs update

Build with `node scripts/build-node-server.mjs` from the repository root. Use a stopped journal directory or a consistent copy. The command sends the reconstructed document to stdout as a binary Yjs v1 update.

```sh
npm --prefix packages/server/node run --silent journal:export -- /path/to/document.journal > document.yjs
```

A successful export applies the active checkpoint or baseline, then its remaining operations. The command exits with an error before emitting bytes if the journal is incomplete, has a damaged record, or ends with unresolved Yjs dependencies.

## Known divergences (planned; see `docs/plans/server-node-nifty-zebra.md`)

- **Journal lock:** no `flock(2)` on Node — O_EXCL + PID liveness instead; concurrent cross-host journal hold with Go/C# is not the same contract.
- **macOS TLS operator verification:** façade reports unavailable (`sectrust` parity deferred).
- **Collaboration:** `GET /sync/{doc}/state` reads the configured document endpoint with its internal credential and checks the requested document against the user's ticket. Bare documents and envelopes are supported. The endpoint supplies the state for a fresh working set. Journal-backed rooms, S3 working sets and existing local working sets return HTTP 501 until replay is implemented.
- Edit, reset, and history routes return HTTP 501. Use the production collaboration host for writes and live sessions.

### Append a Yjs update to an offline journal

Build `node scripts/build-node-server.mjs` from the repository root. Use an existing seeded directory
on a local macOS or Linux filesystem with Python 3. In `packages/server/node`, run:

```sh
npm run --silent journal:append -- "$copy" "$lineage" "$expectedThrough" "$operationId" update.yjs
```

Read the lineage and current sequence with `journal:inspect`. Use one 32-character lowercase hexadecimal
operation ID per change and reuse it after a lost response. The JSON result contains an outcome and a
decimal sequence. A committed update and its identical retry exit 0. A stale head or conflicting ID
exits 3. A busy document exits 4. The input is a binary Yjs v1 update of up to 1 MiB. The command
validates it against the checkpoint and journal before writing. On a verified partial tail, a new append
truncates back to the last whole record. A corrupt checksum stops the operation.

The TypeScript API in `dist/journal-append.mjs` exposes `appendJournal` and accepts bigint sequences.
The writer uses the Go/.NET Unix `lock` file, holding an exclusive nonblocking flock from inspection
through fsync. Python supplies only that system call over an inherited file descriptor. Node owns the
descriptor and performs the complete read, validation and write. The writer requires working flock
semantics and a local filesystem. It fails when the syscall helper is unavailable. The CLI reads the
entire current document on each append and is intended for offline use.
