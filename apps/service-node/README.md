# Blok cloud host (Node) — Hono + Drizzle

Readable scaffold for the **product** backend (`apps/service` in Go). This is **not** the collaboration sidecar (`packages/server/node` uses a custom HTTP stack for Kestrel parity).

## Desktop shell backend

The desktop shell uses the PostgreSQL schema in `apps/service/schema.sql`, initialized by the Go service. The shell entry point runs against that database and serves the following requests.

| Request | Purpose |
| --- | --- |
| `GET /api/session` and `GET /api/workspaces` | Load the signed-in user and memberships with a browser cookie or native bearer token. |
| `GET /api/workspaces/:slug/index` | Read the page tree, trash, access levels and workspace revision from one database snapshot. |
| `GET /api/workspaces/:slug/pages/:id` | Read the persisted page document with inherited visibility and grants. |
| `GET/PUT /internal/documents/:id` | Load or persist a collaboration projection using the service credential and document revision. |
| `GET /healthz` | Check PostgreSQL connectivity. |

Run `npm ci && npm run build && npm run start:shell` from this directory. Set `DATABASE_URL`, `INTERNAL_SECRET`, `PUBLIC_URL` and, for native clients, `ALLOWED_ORIGINS`. Set the Go service's `INTERNAL_URL` to the Node service's private address. A missing or stale write version can produce a 409. A retry of an already stored journal projection returns its existing version.

The Go service continues to own login, workspace mutations, ACL changes, tickets, WebSockets and the operation journal. Live state can lead the PostgreSQL projection until a checkpoint, room eviction or shutdown flushes the journal. Keep the internal callback private. The standalone development API documented below uses its own schema and database.

Run the focused shell tests with `npm test -- src/shell`. Set `SHELL_TEST_DATABASE_URL` to include the PostgreSQL checks. They create and remove a unique schema in that database.

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
9. `src/routes/blok.ts` — sidecar HTTP proxy at `/api/blok/*`; `GET /api/blok/sync/:docId` answers `501 upgrade_required` (plain HTTP or upgrade) with a `ws:`/`wss:` hint to `BLOK_SIDECAR_URL` — live sockets are not reverse-proxied through this host yet

## Dev with Postgres

PostgreSQL 16 via Docker Compose (app still runs on the host):

```bash
cd apps/service-node
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
npm ci          # or npm install
npm run dev
```

`docker-compose.dev.yml` publishes Postgres on `127.0.0.1:5432` with user/password/database `blok` / `blok` / `blok`. `.env.example` sets `PORT=8080`, `DATABASE_URL` to that instance, and `APPLY_SCHEMA_ON_BOOT=1` so the first boot applies `schema.sql` when the DB is empty.

Stop the database: `docker compose -f docker-compose.dev.yml down` (add `-v` to drop the volume).

## Run locally

`GET /health` → `{"status":"ok","version":"…"}`. With `DATABASE_URL` set (see `.env.example`):

```bash
npm run dev
DEV_EXPOSE_AUTH_CODE=1 npm run dev   # returns devCode on request-code
BLOK_SIDECAR_URL=http://127.0.0.1:4000 npm run dev   # proxies /api/blok/*
```

Without `DATABASE_URL`, `GET|POST /api/*` (except `/health`, `/api/instance`, `/api/blok/*`) → `503 database_not_configured`.

Session auth: `verify-code` sets the `blok_session` cookie; most `/api/*` handlers expect a signed-in user (`requireUser`). Admin routes also honor `ADMIN_USER_IDS` when set.

## API routes

Mounted in `src/app.ts`. Paths are flat (Go-style). `:id` / `:workspaceId` are UUIDs unless noted.

### Health & instance

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | — | Liveness + build `version` |
| GET | `/api/instance` | — | `ready`, `database`, `sidecar`, `mailer`, `version` flags |

### Setup

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/setup/status` | — |
| POST | `/api/setup/first-admin` | — |

### Auth & profile

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/auth/request-code` | — |
| POST | `/api/auth/verify-code` | — |
| POST | `/api/auth/logout` | session optional |
| POST | `/api/auth/refresh-session` | user |
| GET | `/api/auth/me` | session optional |
| PATCH | `/api/users/me` | user |

### Workspaces

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/workspaces` | user |
| POST | `/api/workspaces` | user |
| GET | `/api/workspaces/by-slug/:slug` | user |
| GET | `/api/workspaces/:workspaceId` | user |
| PATCH | `/api/workspaces/:workspaceId` | user |
| DELETE | `/api/workspaces/:workspaceId` | user |
| GET | `/api/workspaces/:workspaceId/export` | user |
| GET | `/api/workspaces/:workspaceId/audit` | user |
| GET | `/api/workspaces/:workspaceId/members` | user |
| POST | `/api/workspaces/:workspaceId/members` | user |
| PATCH | `/api/workspaces/:workspaceId/members/:userId` | user |
| DELETE | `/api/workspaces/:workspaceId/members/:userId` | user |
| POST | `/api/workspaces/:workspaceId/transfer-ownership` | user |
| GET | `/api/workspaces/:workspaceId/presets` | user |
| GET | `/api/workspaces/:workspaceId/presets/:presetId` | user |
| POST | `/api/workspaces/:workspaceId/presets` | user |
| PATCH | `/api/workspaces/:workspaceId/presets/:presetId` | user |
| DELETE | `/api/workspaces/:workspaceId/presets/:presetId` | user |

### Invites

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/invites` | user |
| POST | `/api/invites/:id/accept` | user |
| GET | `/api/workspaces/:id/invites` | user |
| POST | `/api/workspaces/:id/invites` | user |
| DELETE | `/api/workspaces/:id/invites/:inviteId` | user |

### Pages & documents

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/workspaces/:workspaceId/pages` | user | List (paginated) |
| GET | `/api/workspaces/:workspaceId/pages/tree` | user | Nested tree |
| GET | `/api/workspaces/:workspaceId/pages/search` | user | |
| GET | `/api/workspaces/:workspaceId/pages/trash` | user | |
| POST | `/api/workspaces/:workspaceId/pages` | user | Create |
| GET | `/api/pages/:pageId` | user | |
| PATCH | `/api/pages/:pageId` | user | |
| DELETE | `/api/pages/:pageId` | user | |
| POST | `/api/pages/:pageId/duplicate` | user | |
| POST | `/api/pages/:pageId/move` | user | |
| POST | `/api/pages/:pageId/reparent` | user | Same validation as move; workspace from page |
| POST | `/api/pages/:pageId/reorder` | user | `{ afterPageId?: string \| null }` among siblings |
| GET | `/api/pages/:pageId/document` | user | Page body snapshot |
| POST | `/api/pages/:pageId/document` | user | |
| PATCH | `/api/pages/:pageId/document` | user | |
| GET | `/api/pages/:pageId/sync/state` | user | Product sync metadata |

### Collaboration (sidecar)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/documents/:docId/state` | session or `Authorization` | Proxies sidecar sync state; mints ticket from session when unauthenticated header |
| POST | `/api/tickets/blok` | user | Mint sidecar access ticket |
| GET | `/api/blok/sync/:docId` | — | `501 upgrade_required` + `ws:`/`wss:` hint (no WS reverse proxy yet) |
| * | `/api/blok`, `/api/blok/*` | — | HTTP reverse proxy when `BLOK_SIDECAR_URL` is set |

### Assets

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/workspaces/:workspaceId/assets` | user |
| POST | `/api/workspaces/:workspaceId/assets` | user |
| GET | `/api/workspaces/:workspaceId/assets/:assetId` | user |
| DELETE | `/api/workspaces/:workspaceId/assets/:assetId` | user |

### Admin

All under `/api/admin/*`: signed-in user + `requireAdmin` (`ADMIN_USER_IDS` when non-empty).

| Method | Path |
| --- | --- |
| GET | `/api/admin/users` |
| GET | `/api/admin/users/:id` |
| GET | `/api/admin/workspaces` |
| GET | `/api/admin/audit` |

## Imports

Cross-module paths use the `@/` alias (`package.json` `imports` → `dist/` at runtime; `tsconfig` `paths` → `src/` for typecheck and `tsx`/`vitest`). Same directory keeps `./foo.js`; never `../../`.

## Scripts

- `npm run dev` — `tsx watch src/main.ts`
- `npm run start` — compiled `dist/main.js`
- `npm run build` — `tsc`
- `npm run test` — vitest

No `drizzle-kit generate` / `migrate` in scripts (schema stays `schema.sql`-driven per plan).

## Relation to `packages/server/node`

Sidecar = editor HTTP (upload, sync, unfurl). **This** app = accounts, workspaces, pages in PostgreSQL. Later it will embed the sidecar in-process or proxy to it.