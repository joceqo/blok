# Blok cloud host (Node) — Hono + Drizzle

Readable scaffold for the **product** backend (`apps/service` in Go). This is **not** the collaboration sidecar (`packages/server/node` uses a custom HTTP stack for Kestrel parity).

## Stack

| Layer | Choice |
| --- | --- |
| HTTP | [Hono](https://hono.dev) on `@hono/node-server` (`node:http`) |
| DB driver | `pg` (`Pool`) |
| SQL typing | [Drizzle](https://orm.drizzle.team) query builder only — no `db.query.*` relational API |
| Schema truth | `schema.sql` (same file as Go, when present) — Drizzle tables are generated via `drizzle-kit pull`, not hand-maintained long term |

## Layout (read in this order)

1. `src/main.ts` — config, DB pool, listen
2. `src/app.ts` — Hono app, global middleware, route mounts
3. `src/routes/*.ts` — one file per domain (flat paths like Go)
4. `src/routes/pages.ts` — pages CRUD + `permissions.assertPageAction`
5. `src/db/schema.ts` — table shapes Drizzle needs at runtime (bootstrap subset)
6. `src/db/transaction.ts` — `withTransaction` for multi-statement handlers
7. `src/db/index.ts` — `drizzle(pool, { schema })`
8. `src/permissions.ts` — pure permission matrix (port of `permissions.go` lot 1)
9. `src/routes/blok.ts` — placeholder pour le sidecar `/api/blok`

## Run locally

```bash
cd apps/service-node
npm ci          # after lockfile exists: npm install
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/blok
export PORT=8080
npm run dev
```

`GET /health` → `{"status":"ok"}`. With `DATABASE_URL` set, `GET /api/workspaces` lists rows (needs tables from `schema.sql`).

## Scripts

- `npm run dev` — `tsx watch src/main.ts`
- `npm run start` — compiled `dist/main.js`
- `npm run build` — `tsc`
- `npm run test` — vitest

No `drizzle-kit generate` / `migrate` in scripts (schema stays `schema.sql`-driven per plan).

## Relation to `packages/server/node`

Sidecar = editor HTTP (upload, sync, unfurl). **This** app = accounts, workspaces, pages in PostgreSQL. Later it will embed the sidecar in-process or proxy to it.