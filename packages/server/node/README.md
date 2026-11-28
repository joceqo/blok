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

### One-document WebSocket preview

`journal:room` serves a format-2 journal copy on `127.0.0.1`. Build the Node server first, install
the package dependencies, and use a dedicated secret of at least 32 characters. In
`packages/server/node`, the following commands start a preview and issue a five-minute ticket
from another terminal with the same secret:

```sh
export BLOK_ROOM_SECRET="$(openssl rand -hex 32)"
npm run --silent journal:room -- "$copy" preview-page http://localhost:18098 18102
npm run --silent journal:room -- --ticket preview-page demo-user write
```

Connect to `ws://127.0.0.1:18102/api/blok/sync/preview-page` with the explicit allowed origin,
offering `blok-sync.v2`, `blok-sync.v1` and the opaque ticket in Sec-WebSocket-Protocol.
The API `startJournalRoom({ directory, documentId, allowedOrigins, port, authorize })` lets a host
supply fresh page permissions. It rechecks each incoming message, each broadcast recipient, and
idle connections every second. The journal lock is held for the entire process lifetime. After a
successful append the room broadcasts the update, then acknowledges its sequence. On storage
failure it closes the room and releases the journal so a supervisor can restart it from disk.

The preview implements sync, operation acknowledgement/rejection, reconnect and replay on one
seeded document. Presence, HTTP edits, checkpoint rotation and multi-workspace routing are outside this preview.
The product projection mode below adds seeding and snapshot persistence. Each changed operation rechecks
the journal in full and is intended for small local documents. A workspace rollout requires
workspace-scoped ticket issuance and live ACL callbacks, exclusive ownership of each selected
journal across Go and Node, snapshot persistence, and an explicit proxy route for the selected
documents. The normal shell continues to use its configured collaboration host.

### Use real shell tickets and page permissions in one preview room

Run a cloud service that provides `POST /internal/room-access` and give the Node process
the service's internal origin and `INTERNAL_SECRET` through the deployment environment.
The built-in private demo signer is disabled in shell mode. The cloud service retains its
ticket-signing key. Starting from `packages/server/node`:

```sh
BLOK_ROOM_CLOUD_ORIGIN=http://127.0.0.1:8080 \
npm run --silent journal:room -- "$copy" "$pageId" http://localhost:18098 18102
```

Sign in to the shell, fetch a ticket from `GET /api/workspaces/{slug}/ticket?doc={pageId}`, and
offer it as a WebSocket subprotocol. The controller verifies the signature, 60-second admission
deadline, session and exact page. For an established socket, the room rechecks that same session
and page on incoming frames, before broadcasting updates, and once per second while idle. It
keeps the write ceiling from the original ticket across later permission changes. A revoked
or expired session closes with code 4403. A new connection requires a valid upgrade ticket.

With only the ACL service configured, the operator supplies a document ID and its seeded directory.
The shell deployment controls which pages reach this process and which host owns their writes.

The acceptance scenario in `test/shell-room-acl.mjs` is run by the Go integration test
`TestNodeRoomAgainstCanonicalACL`. Build the room first, set `TEST_DATABASE_URL` and
`BLOK_TEST_NODE_ROOM_SCENARIO` to the script's absolute path, then run the Go test. It
creates a private PostgreSQL schema and tests two clients against real short-lived Go tickets
and live page-share changes.


### Persist one shell page to the product database

For a page exclusively routed to Node, set both private service origins and the shared
`INTERNAL_SECRET`. The projection endpoint must support exact version, lineage and sequence
preconditions. Pass the collaboration **root directory** used by the Go host for that page.

```sh
BLOK_ROOM_CLOUD_ORIGIN=http://shell:8080 \
BLOK_ROOM_PROJECTION_ORIGIN=http://service-node:8090 \
npm run --silent journal:room -- /data/collab "$pageId" http://localhost:18098 18102
```

The room maps the page ID to `<sha256(id)>.journal` and holds the same filesystem lock as Go.
Deploy the page's routing and write fence on the product host before starting the room.
`GET /healthz` returns the active document ID and backend after startup has reconciled journal
and projection. `ALLOWED_ORIGINS` accepts additional comma-separated browser and Tauri
origins. The socket listens on loopback by default. Set `BLOK_ROOM_LISTEN_HOST=0.0.0.0`
only inside a private network behind an authenticating shell proxy.

A new page receives a sealed format-2 baseline built with the editor's serializer. The
original snapshot must round-trip through it without loss. Unsupported JSON numbers and a database lineage without its journal or matching legacy
working set stop startup. Existing Go
journals require a readable format-2 state whose corresponding prefix matches PostgreSQL.
The room retains outer snapshot metadata and refuses updates with unprojectable roots,
host-owned history values or unrecognized block and page fields.

For each changed operation, the room validates its candidate snapshot, appends and fsyncs
the journal, updates the product database with exact preconditions, and fsyncs its local
projection receipt before broadcasting and acknowledging. A restart reconciles a committed
journal entry with a missed database write or a lost receipt. Retrying the operation ID
then returns its durable sequence. A conflicting canonical revision stops the room for
operator reconciliation and leaves both the existing database content and the journal
available for inspection.

The opt-in socket/storage test uses a temporary schema. Build both services first and run
`SHELL_TEST_DATABASE_URL=postgres:///test node --test test/page-projection.mjs` from this
package. To test a separate product checkout, set `BLOK_SHELL_TEST_ROOT` to its root.


### Serve a workspace

The product demo can give the Node host ownership of a whole workspace. The host starts a document room on the first authorized WebSocket, serializes concurrent opens of that page, and releases its journal lock after the last connection closes. Other pages have independent queues and leases. A reconnect waits for a draining writer before reopening the same journal.

In workspace mode the CLI takes `<journal-root> --workspace <allowed-origin> [port]` and reads the canonical `BLOK_NODE_ROOM_WORKSPACE` ID. The product service must return that workspace ID when it verifies a ticket or rechecks a session. An unauthorized request cannot initialize a journal. This host supports 128 simultaneously resident pages, 32 WebSocket connections per page and 256 handshakes in flight. The other pages remain available on demand as rooms drain.


### Import a local Go working set during a handoff

Stop any legacy non-journal writer and transfer the page to the Node room. When the
page has only the unsuffixed SHA-256 file, Node reads its Go `BKW2` header and framed
Yjs log. It accepts editor format 2 with an epoch the wire protocol can represent.
The materialized content must match the canonical product snapshot. The database
must have either an unassigned lineage or the matching lineage at sequence zero.

The room seals the original frame bytes in the sequence-zero baseline, carries forward
the original epoch and lineage, and publishes the journal directory atomically. It
leaves the legacy file in place. Known journals always reopen through their manifest.
A damaged header, incomplete Yjs state, concurrent source replacement or conflicting
canonical snapshot stops the import before publication. A legacy non-journal writer
does not participate in the journal's flock and must stay stopped after handoff.

The opt-in Go test `TestNodeImportsGoWorkingSetWithoutChangingItsIdentity` uses the actual
Go codec to create a two-frame file, has Node append a dependent edit and project it to
PostgreSQL, and lets Go reopen the journal to compare the complete original frames.
Build the Node room and product service. Set `SHELL_TEST_DATABASE_URL` to a disposable
PostgreSQL database and `BLOK_TEST_NODE_WORKING_SET` to the absolute path of
`test/legacy-import.mjs` in this package, then run that test in Go's
`internal/collab/journal` package.
