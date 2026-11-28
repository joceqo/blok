# Blok product backend for the web and desktop shell

The TypeScript service in `src/shell` serves accounts, workspaces, permissions, hosted AI and MCP, and persists documents in PostgreSQL. The collaboration and media processes run the Node host in `packages/server/node`.

## Desktop shell backend

On startup the shell applies the canonical `apps/service/schema.sql` inside a transaction under a PostgreSQL advisory lock. The same entry point serves the web and Tauri clients.

| Request | Purpose |
| --- | --- |
| `POST /api/auth/request-code`, `/verify-code`, `/logout` | Issue and verify a code or close a session. The Node transport delivers via SMTP, Resend or the development mailbox. |
| `GET/POST /api/workspaces/:slug/invites` and `DELETE .../invites/:id` | List, deliver and revoke workspace invitations. |
| `POST /api/workspaces/:slug/search` | Find accessible pages by title or saved block text. |
| `GET/POST /api/mcp/tokens`, `DELETE /api/mcp/tokens/:id`, `POST /api/mcp/tokens/:id/rotate` | List, issue, revoke and rotate the signed-in account’s MCP tokens. The hosted Node MCP endpoint checks live token and workspace permissions. |
| `GET /api/session` and `GET /api/workspaces` | Load the signed-in user and memberships with a browser cookie or native bearer token. |
| `GET /api/workspaces/:slug/index` | Read the page tree, trash, access levels and workspace revision from one database snapshot. |
| `PUT /api/workspaces/:slug/index` | Create, rename, reorder, move, trash or remove pages in one transaction, conditional on the last observed workspace revision. |
| `GET /api/workspaces/:slug/pages/:id` | Read the persisted page document with inherited visibility and grants. |
| `GET/PUT /api/workspaces/:slug/pages/:id/access` | Read effective permissions or change page visibility. |
| `PUT/DELETE /api/workspaces/:slug/pages/:id/shares/:target` | Grant, update or revoke a direct share for a workspace member. |
| `GET /api/workspaces/:slug/members` and `PATCH/DELETE /api/workspaces/:slug/members/:userId` | List workspace members, change a role, or remove a member and their grants. |
| `/api/workspaces/:slug/teamspaces` | List and manage teams, their members and linked pages. |
| `GET/PUT /internal/documents/:id` | Load or persist a collaboration projection using the service credential and document revision. |
| `GET /healthz` | Check PostgreSQL connectivity. |

From the repository root run `./deploy/demo.sh start` for a working shell, mailbox and PostgreSQL instance. The deployment builds the API, collaboration, media, MCP and web images from `deploy/Dockerfile` with the repository root as build context. See the [deployment guide](../../deploy/README.md).

To develop the API process alone against a development PostgreSQL database, run the following from `apps/service-node`. Keep the two secrets consistent across API restarts and all participating processes.

```sh
npm ci
export DATABASE_URL=postgres://blok:blok@127.0.0.1:5432/blok
export PUBLIC_URL=http://localhost:8081 PORT=8081
export INTERNAL_SECRET="$(openssl rand -hex 32)"
export TICKET_SECRET="$(openssl rand -hex 32)"
export DATA_DIRECTORY="$PWD/data" APP_ENV=development
export DEV_MAIL_DIRECTORY="$DATA_DIRECTORY/mail"
npm run dev
```

`npm run dev` watches `src/shell/main.ts`. For compiled code run `npm run build && npm start`, which executes `dist/shell/main.js`. `GET /healthz` checks database connectivity. Use the Docker deployment for uploads, live editing and the bundled MCP runtime. For native clients configure their webview origins with `ALLOWED_ORIGINS`.

The shell sends `{ revision, pages, trash }` when saving its sidebar and receives `{ revision }` after a successful write. An outdated revision returns 409. Invisible pages and read-only metadata survive a partial index. Private creation gives the author full access in the same transaction. An existing tombstone reserves its page ID.

After a sharing or membership change, the service calls the Node room listener at `127.0.0.1:18102/internal/room/recheck-access`. If a callback fails after the database transaction commits, the shell receives HTTP 503 and can reload the committed revision. Live changes remain in the durable collaboration journal while the PostgreSQL projection catches up.

Run the focused shell tests with `npm test -- src/shell`. Set `SHELL_TEST_DATABASE_URL` to include the PostgreSQL checks. They create and remove a unique schema in that database.

The integration tests read `apps/service/schema.sql` from the product checkout by default. When developing the Node service on its standalone branch, point `SHELL_TEST_SCHEMA_PATH` at the canonical file in a sibling checkout of `integration/tout`. Run this from `apps/service-node` with a development database that permits creating schemas.

```sh
SHELL_TEST_SCHEMA_PATH=/absolute/path/to/blok-product/apps/service/schema.sql \
SHELL_TEST_DATABASE_URL=postgresql://localhost/blok_test \
npm test -- src/shell/app.integration.test.ts
```

## Historical prototype (`src/main.ts`)

The following sections describe the separate Drizzle prototype and its schema. Its routes differ from the deployed shell. To run that prototype explicitly use `npx tsx src/main.ts` in a separate development database.

### Stack

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

### Prototype database

PostgreSQL 16 via Docker Compose (app still runs on the host):

```bash
cd apps/service-node
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
npm ci          # or npm install
npx tsx src/main.ts
```

`docker-compose.dev.yml` publishes Postgres on `127.0.0.1:5432` with user/password/database `blok` / `blok` / `blok`. `.env.example` sets `PORT=8080`, `DATABASE_URL` to that instance, and `APPLY_SCHEMA_ON_BOOT=1` so the first boot applies `schema.sql` when the DB is empty.

Stop the database: `docker compose -f docker-compose.dev.yml down` (add `-v` to drop the volume).

### Running the prototype

`GET /health` → `{"status":"ok","version":"…"}`. With `DATABASE_URL` set (see `.env.example`):

```bash
npx tsx src/main.ts
DEV_EXPOSE_AUTH_CODE=1 npx tsx src/main.ts   # returns devCode on request-code
BLOK_SIDECAR_URL=http://127.0.0.1:4000 npx tsx src/main.ts   # proxies /api/blok/*
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

Write local module imports with their source extension, for example `import type { User } from '../models/User.ts'`. This package's TypeScript compiler rewrites those paths to `.js` in `dist/` for Node's ESM runtime. Run `npm run build` to compile both entry points.

## Scripts

- `npm run dev` — `tsx watch src/shell/main.ts`
- `npm start` — compiled `dist/shell/main.js`
- `npm run build` — `tsc`
- `npm run test` — vitest

No `drizzle-kit generate` / `migrate` in scripts (schema stays `schema.sql`-driven per plan).

## Relation to `packages/server/node`

The deployment starts `app`, `room` and `media` from one Node image. The API owns permissions and the PostgreSQL schema. The room owns the document journal and its WebSockets. The media host serves file operations on a private loopback port behind the shell’s access checks.

The API build also bundles the hosted MCP server from the workspace. Install the root JavaScript dependencies for a source build. Both Dockerfile paths use the repository root as the build context, e.g. `docker build -f deploy/Dockerfile --target service .`.
