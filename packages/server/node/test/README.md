## Journal process tests

Build the Node server bundles from the repository root, then run the opt-in process tests. They need the Go toolchain and the same Python 3 interpreter used by the Node writer to acquire the Go-compatible file lock.

```sh
node scripts/build-node-server.mjs
cd packages/server/node
node --test test/journal-append.process.test.mjs
```

Each run copies the closed Go fixture into a temporary directory. Independent Node processes submit Yjs updates, retry after a process is killed and recover from a truncated final record. A real Go store holds the document while a Node writer tries to open it, then reopens the result after the Node writer commits. The tests verify document state by invoking the offline export CLI.

A prebuilt Go fixture command can be selected with `BLOK_TEST_GO_JOURNAL_HOLDER`. Build it from `packages/server/go` with `go build -o /path/to/hold-open ./internal/collab/journal/testdata/hold-open`.
