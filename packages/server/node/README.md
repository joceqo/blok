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

## Known divergences (planned; see `docs/plans/server-node-nifty-zebra.md`)

- **Journal lock:** no `flock(2)` on Node — O_EXCL + PID liveness instead; concurrent cross-host journal hold with Go/C# is not the same contract.
- **macOS TLS operator verification:** façade reports unavailable (`sectrust` parity deferred).
- **Collaboration:** `GET /sync/{doc}/state` reads the configured document endpoint with its internal credential and checks the requested document against the user's ticket. Bare documents and envelopes are supported. The endpoint supplies the state for a fresh working set. Journal-backed rooms, S3 working sets and existing local working sets return HTTP 501 until replay is implemented.
- Edit, reset, and history routes return HTTP 501. Use the production collaboration host for writes and live sessions.
