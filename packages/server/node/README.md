# `@bloklabs/server-node`

Fourth Blok server host implementation: HTTP/1.1 on `node:net` with Kestrel wire behaviour (not `node:http`), measured against the shared conformance fixtures.

**Not published** (`private: true`), same as Rust before it ships.

## Build

```bash
node scripts/build-node-server.mjs
```

Produces `packages/server/node/dist/blok-server` (ordinary) and `dist/blok-server-conformance` (`BLOK_CONFORMANCE=true`).

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
