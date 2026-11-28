# Journal, snapshot, debounce

Audit comparatif du backend Node de Blok face à AFFiNE et Docmost.
Bugs de synchronisation, failles de sécurité, failles base de données.

- **Date** : 26 novembre 2026
- **Worktree** : `work/sync`, branche `feat/desktop-device-account`
- **Périmètre** : `packages/server/node` (collab WebSocket) + `apps/service-node` (REST)
- **Méthode** : analyse statique. Aucune vérification dynamique exécutée.
- **Références** : AFFiNE `packages/backend/server/src/core/{doc,sync}`, Docmost `apps/server/src/collaboration`

---

## 1. Deux constats structurels

### 1.1 Un paquet, deux backends REST incompatibles

| | Pile « shell » | Pile « routes » |
|---|---|---|
| Entrée | `src/shell/main.ts` | `src/app.ts` + `src/routes/*` |
| Démarrée par | `dev`, `start`, `start:shell` | **aucun script npm** |
| Accès base | `pg` brut, schéma Go | Drizzle, `apps/service-node/schema.sql` |
| Transactions | `BEGIN`, `FOR UPDATE`, `SERIALIZABLE` | quasi absentes |
| Tests | ~20 suites d'intégration Postgres | aucun test de route |

Les deux `schema.sql` divergent de 34 tables. Le fichier Node l'admet en ligne 1 :
« Bootstrap only for local reading until apps/service/schema.sql is vendored here. »

La pile « routes » n'est pas du code mort : compilée par `tsc`, exportée, et instanciée par
`test/unit/service-conformance/service-app.ts`. Ses défauts sont à un `npm start` près d'être
exploitables.

### 1.2 Un paquet serveur, deux serveurs

| | Hôte HTTP | Salle temps réel |
|---|---|---|
| Binaire | `bin/blok-server.mjs` | `bin/blok-journal-room.mjs` |
| Source | `src/main.ts` | `src/collab/room/preview.ts` |
| WebSocket | `GET /sync/{doc}` → **400** | `/api/blok/sync/{id}` |
| `edit`, `reset`, `history/*` | **501** (`src/host/map-routes.ts:213-230`) | servis, sauf `/edit` |

Le README décrit la salle comme une **preview mono-document** visant « small local documents »,
sans rotation de checkpoint. Or `apps/service-node/src/shell/main.ts:17` force
`BLOK_NODE_ROOM_ALL = '1'` : la pile livrée est câblée pour que Node soit l'hôte de salle.
La moitié des points du §3 découle de cet écart.

---

## 2. Les trois architectures

| | Blok (Node) | AFFiNE | Docmost |
|---|---|---|---|
| Transport | `ws` brut, `blok-sync.v2` | socket.io / NestJS | hocuspocus |
| Substrat durable | **fichiers POSIX + `flock(2)`** ; Postgres = projection HTTP | Postgres : `snapshot` + `updates` | Postgres : `ydoc` + `content` |
| Unité d'écriture | 1 enregistrement/opération, double SHA-256, séquence contiguë | updates empilés, squash à la lecture | 1 blob réécrit |
| Cadence | **fsync par opération** | à chaque push | **debounce 10 s, max 45 s** |
| Compaction | **aucune** (checkpoints lus, jamais écrits) | `squashUpdatesToSnapshot` | implicite |
| Reçu client | **ack + séquence serveur sans trou** | aucun | `synced`, sans durabilité |
| Idempotence | `operationId` + digest **persistés** | CAS timestamp + 16 retries | aucune |
| Quarantaine des rejets | spécifiée, implémentée 4× | aucune | aucune |
| Scaling horizontal | **impossible** (flock + RAM) | event bus cluster | **Redis pub/sub + lock/doc** |
| ACL en session | par trame *et* par destinataire, sans cache | événementielle, génération anti-TOCTOU | à la connexion |
| Keepalive WS | **aucun** | natif | natif |
| Spéc. normative | **1195 l. + fixtures + 8 scénarios** | aucune | aucune |

Note : le verrou d'AFFiNE est cassé. `core/doc/storage/lock.ts` déclare `lockedResource = new Map()`
et n'appelle jamais `.set()` : chaque `lock()` crée un `Lock` neuf, aucune exclusion mutuelle.

---

## 3. Bugs de synchronisation (`packages/server/node`)

### 3.1 Latence d'écriture en O(historique), sans borne — CRITIQUE

`appendHeld` (`src/collab/journal/append.ts:115`) appelle `inspectJournal` **à chaque append**.
`inspect.ts:46-76` relit le journal entier, revérifie deux SHA-256 par enregistrement et rejoue
tout l'historique dans un `Doc` jetable. Chaque frappe = un rescan + un replay Yjs complets.

Rien ne tronque : `checkpointName` n'apparaît qu'en lecture (`inspect.ts:119`). Node lit les
checkpoints Go mais n'en publie aucun. Le journal croît indéfiniment, le coût avec lui.

En face : AFFiNE écrase en snapshot sous verrou et archive en historique ; Docmost garde un blob.

À décharge : `README.md:109` l'assume (« intended for small local documents »). Le défaut est
que ce code est câblé comme hôte de salle.

### 3.2 ACL revérifiée dans la boucle chaude — CRITIQUE

`document-room.ts` appelle `principal()` : par trame entrante (`:164`), **par destinataire** avant
chaque diffusion (`:123`), deux fois par pair à chaque message de présence (`:157`), après le
commit (`:103`), et pour tous les pairs toutes les secondes (`:250`).

Avec `shellRoomTickets`, chaque appel est un `fetch` vers `/internal/room-access`, timeout 2 s,
**sans cache**, dans la queue sérialisée de la salle. Une opération la bloque sur 3 fsync + un PUT
HTTP (6 s de timeout) + N requêtes. À 32 pairs : plus de trente appels réseau par frappe.

En face : AFFiNE revalide sur événement (`@OnEvent('workspace.members.*')`) avec une génération
de permissions, jamais dans le chemin d'écriture.

### 3.3 Panne réseau transitoire lue comme une révocation — ÉLEVÉ

`document-room.ts:56-57` : `catch { identity = null }` → `close(4403, 'forbidden')` (`:60`), code
terminal. En `:103` cela survient **après** que l'opération est journalée : le client ne reçoit
jamais l'ack d'un travail enregistré. Pas de perte (retry idempotent), mais refus définitif pour
une cause passagère.

### 3.4 Index d'idempotence non borné en RAM — ÉLEVÉ

`document-room.ts:43` + `:79-80` : un élément par enregistrement historique entre en mémoire à
l'ouverture. Jamais purgé, pas de TTL, pas de coupure au checkpoint. En mode mono-document la
salle n'est jamais déchargée (`preview.ts:170-172`).

### 3.5 Aucun keepalive WebSocket — ÉLEVÉ

Aucun `ping`/`pong`/`isAlive`/`heartbeat` dans `packages/server/node/src`. Une socket semi-ouverte
garde son `Peer`, ses entrées de présence et son slot (32/document, `preview.ts:165`) jusqu'au
timeout TCP. La présence n'a aucune expiration. socket.io et hocuspocus le fournissent nativement.

### 3.6 Balayage périodique hors de la queue — MOYEN

`document-room.ts:247-251` : `setInterval(…, 1000)` exécute `Promise.all(…, principal)` hors de la
chaîne `queue`. Le flag `sweeping` n'empêche pas le chevauchement avec un `commit()` en cours.

### 3.7 Écarts avec la spécification normative — MOYEN

| Point | Spec | Code |
|---|---|---|
| Raison du 4503 | `commit unavailable, retry` (§6.1) | `'commit unavailable'` (`:129`) |
| `oversized-update` | « never sends » (§11.3) | émis (`:94`) |
| Routes HTTP | `/sync/{doc}/…` avec `/edit` | `/api/blok/sync/{id}/…`, sans `/edit` |
| Statuts 500/501 | distincts (§12.4) | tout en 503 (`preview.ts:253`) |

### 3.8 Les 8 scénarios de durabilité ne tournent jamais contre cette salle — CRITIQUE

`.github/workflows/ci.yml` (lignes 140, 144, 473, 484, 756) lance la conformance avec `--target`
∈ {`rust`, `interop-rust`, `csharp`, `interop`, `go`} — **jamais `node`**. Et la cible `node`
construit `dist/blok-server.mjs`, l'hôte HTTP sans WebSocket et avec `edit`/`history` en 501 :
S1–S8 y sont inatteignables par construction.

Trous : S3 (ack puis SIGKILL), S5/S6 (checkpoints, non produits par Node), concurrence
multi-écrivains, backpressure, trames malformées.

### 3.9 La quarantaine est écrite 4 fois, aucune en Node — ÉLEVÉ

La §6 du protocole fait de la quarantaine une obligation du **receveur**. Quatre codes sont
**finaux** — `invalid-update`, `oversized-update`, `read-only`, `operation-id-conflict` — et
imposent de mettre en quarantaine l'opération *et la queue de lignée restante*. Un code inconnu
se traite comme final. `not-synced` est le seul transitoire.

| Implémentation | Emplacement | Store |
|---|---|---|
| Client TypeScript | `src/components/modules/collaboration/` (`operation-store.ts`, `offline-scope.ts`, `tracking-outbox.ts`) | IndexedDB, object store `quarantine` |
| Go | `packages/server/go/blokmcp/room.go` — `quarantineTail()` | mémoire du participant |
| C# | 9 fichiers | — |
| Rust | 4 fichiers | — |
| **Node serveur** | **aucune** | — |

L'absence côté serveur est normale (un serveur émet les rejets). Le problème est qu'un
**participant Node** — agent MCP, sidecar d'import, tâche de fond — n'a que le provider client via
`src/mcp/live/node-socket.ts`, dont la quarantaine est adossée à IndexedDB. Le code le dit :

```
/** Offline was asked for and the database could not be opened. The queue runs
 *  in memory so the tab's work survives until it is exported, but nothing in
 *  it is durable, so nothing in it is sendable either. */
storageUnavailable: boolean;        // operation-store.ts:112-120
```

Sous Node, deux issues : demander un `offlineScope` et tomber en `storageUnavailable` (plus rien
n'est envoyable), ou passer `offlineScope: null` et drainer sans quarantaine persistante ni
durabilité. Un participant Node qui doit survivre à un redémarrage n'a pas de brique prête.

Ni AFFiNE ni Docmost n'ont de notion de quarantaine : un rejet y laisse le contenu tapé dans le
document local, sans trace récupérable.

### 3.10 Points mineurs

- `preview.ts:131` — `unfinishedPurges.delete(id)` hors `finally` : un échec de `purgeDocument`
  rend le document inaccessible jusqu'au redémarrage.
- `document-room.ts:167-203` — pas de `default` dans le `switch` : une trame `malformed` est
  ignorée sans fermeture ni log (pour `unknown`, conforme §10).
- `document-room.ts:187` — `catch { return }` laisse `peer.synced === false` ; toute opération
  suivante est rejetée `not-synced` jusqu'au prochain `syncStep1` client.
- `document-room.ts:207` — salle en arrêt → `1003 'binary frames required'`, raison trompeuse.

---

## 4. Backend REST

### 4.1 Pile « shell » (livrée)

Au-dessus des deux références sur la cohérence transactionnelle :

- CAS versionné sur la projection — `shell/projection.ts:71-106` (`FOR UPDATE`, décision
  `write`/`retry`/`conflict`, `version+1` en transaction)
- Purge deux phases avec outbox et reprise 5 s — `shell/page-purge.ts`, `page_purge_requests`
- Compensation d'upload — `shell/assets.ts:166-190`
- Re-vérification d'accès poussée vers la salle — `shell/recheck-access.ts`

Écarts avec le Go :

- `shell/page-level.ts:11` — `ceiling = role === 'viewer' ? 0 : 2`, **sans branche par défaut**,
  là où `capOf` en Go a `default: none`.
- Aucun `shell/page-level.test.ts` : les 24 cas de `TestResolveTruthTable` non transposés.
- Modèle de permissions réimplémenté en SQL récursif **4 fois**, avec écarts sur
  `nullif(parentId,'')`, `NOT trashed` et le plafond de rôle. Le Go l'interdit par
  `permissions_law_test.go` (parse l'AST de tous les fichiers) ; côté Node, rien.
- `shell/workspace-directory.ts:191` — `JSON.stringify(document)` au seed détruit les lexèmes
  numériques, alors que `shell/app.ts:172` les préserve sur la route voisine.
- `room_tickets_parity_test.go` et `room_access_test.go:126` pointent vers
  `apps/service-node/test/room-tickets-parity.mjs`, **qui n'existe pas** : les deux tests de
  parité Go↔Node sont désarmés en permanence.

### 4.2 Pile « routes » (non démarrée)

~2 500 lignes de handlers sans test HTTP (`workspaces.ts` 731 l., `pages.ts` 643 l., `auth.ts`,
`admin.ts`, `tickets.ts`, `teamspaces.ts`). `src/app.integration.test.ts:38` instancie
`createApp({ database: undefined })` : rien n'est testé contre Postgres.

- **Race du dernier owner** — `routes/workspaces.ts:364-388` et `:672-690` : comptage hors
  transaction puis écriture ⇒ workspace à zéro owner. La pile shell fait `FOR UPDATE` + recompte.
- **Cycle de hiérarchie** — `pages/page-reparent.ts:39-52` : vérification en JS, hors transaction,
  sans verrou ⇒ deux reparents concurrents créent un cycle.
- **Audit amputé** — `routes/workspaces.ts:220-245` : comptage hors transaction, événement d'audit
  inséré avant la suppression, `assets`/`workspace_images` orphelins faute de FK.
- **Aucun `bodyLimit`** sur `src/routes/*`.

---

## 5. Failles de sécurité

### 5.1 Exploitables aujourd'hui — serveur collab

| Faille | Emplacement | Nature |
|---|---|---|
| **DoS passif sur un document** | `preview.ts:165` + absence de ping/pong | 32 sockets abandonnées sans `close` saturent le document jusqu'au timeout TCP |
| **Monopolisation de la présence** | `presence.ts` | un pair occupe les 128 slots avec 128 messages d'une entrée |
| **Ticket en query string** | `preview.ts:227-228` | `?ticket=<jwt>` → logs d'accès, historique, `Referer` |
| **Identités MCP en salle** | `shell/room-tickets.ts:28-30, 127` | un jeton machine devient participant ; le Go ne joint que `sessions` |
| **Sous-requête non bornée** | `shell/room-tickets.ts:48` | `UNION ALL` sans `LIMIT 1` → `more than one row returned by a subquery` |

### 5.2 Exploitables dès qu'on démarre `src/main.ts` — pile « routes »

| Faille | Emplacement | Exploitation |
|---|---|---|
| **Fuite inter-tenant des documents** | `routes/documents.ts:16-37` | `GET /api/documents/:docId/state` frappe un pass de lecture pour un `docId` arbitraire, sans `requireUser` ni contrôle d'appartenance. `documents.test.ts:46-63` fige le comportement. |
| **Traversée de chemin** | `routes/documents.ts:37` | `docId` interpolé sans validation puis `new URL()` ⇒ accès aux routes `/internal/*` du sidecar |
| **Admin d'instance par défaut** | `middleware/admin.ts:19-22` | `admins.size > 0 && …` : `ADMIN_USER_IDS` absent ⇒ tout utilisateur connecté est admin |
| **Backdoor d'authentification** | `middleware/session.ts:15` | `let userId = process.env.DEV_USER_ID`, sans garde `NODE_ENV` |
| **Proxy non authentifié** | `app.ts:42` + `routes/blok.ts:66-67` | `createBlokRoutes()` monté avant `sessionMiddleware` ; `all('/api/blok/*')` relaie tout au sidecar |
| **Brute-force du code à 6 chiffres** | `routes/auth.ts:84-97` | aucun compteur d'essais ⇒ 10⁶ combinaisons en 10 min |
| **Code de connexion en réponse HTTP** | `routes/auth.ts:30,65` | `NODE_ENV=development` ⇒ `devCode` renvoyé pour n'importe quelle adresse |

Élevées :

- **Tickets** (`routes/tickets.ts:41-82`, `documents/ticket-forward.ts:12`) — aucune ACL de page
  (rôle workspace seul) ; TTL choisi par le client, non borné ; ticket sans claim `doc` si `doc`
  omis ; sujet d'identité = UUID utilisateur au lieu du digest de session, donc **révoquer une
  session ne révoque pas les tickets** ; secret `BLOK_SECRET` vs `TICKET_SECRET` ailleurs.
- **Escalade admin → owner** (`routes/workspaces.ts:309-341`, `routes/invites.ts:20-88`) — garde
  `'share'` (= admin) puis `parseWorkspaceRole` accepte `'owner'`, contournant
  `validateMemberRoleChange` et `validateOwnershipTransfer`.
- **Dernier owner supprimable** (`:700-731`) — la garde exclut l'auto-suppression ; un owner
  unique se retire via `/members/:userId` et le workspace devient ingérable.
- **Fuite d'internes** (`middleware/error.ts:18-20`) — message brut de toute exception en 500,
  erreurs `pg` comprises.
- **CORS** (`app.ts:37`) — `cors({ credentials: true })` sans `origin` ; défaut Hono `'*'`
  (`hono/dist/middleware/cors/index.js:43`). Cassé côté navigateur, et aucune allow-list.
- **Sessions sans rotation ni révocation** ; logout avec regex de cookie non ancrée
  (`routes/auth.ts:129`) : `xblok_session=…` matche en premier.

---

## 6. Failles base de données

### 6.1 Contraintes d'intégrité absentes

Le schéma Go compte une vingtaine de `CHECK`. Le schéma Node n'en a **aucun**.

| Objet | Go | Node |
|---|---|---|
| rôle d'appartenance | `CHECK(role IN ('admin','member','viewer'))` | `varchar(32) NOT NULL`, rien |
| rôle d'invitation | `CHECK(role IN ('member','viewer'))` | aucune |
| `pages.visibility` | `CHECK(… IN ('inherit','private','workspace'))` | **colonne absente** |
| `page_shares.level` | `CHECK(level IN ('view','edit','full'))` | **table absente** |
| `invites.expires_at` | `NOT NULL` | **colonne absente** (invitations éternelles) |
| `login_codes.attempts` / `sent_at` | présents | **absents** d'`auth_challenges` |

La dernière ligne **est** la cause du brute-force §5.2 : la pile shell peut écrire
`WHERE attempts < 5 … FOR UPDATE` parce que le schéma Go porte le compteur.

Même mécanique pour les permissions : le `CHECK` sur `role` était la garde en profondeur derrière
`capOf`. Le schéma Node le retire, et `shell/page-level.ts:11` a perdu sa branche par défaut.

### 6.2 Clés étrangères et cascades

- `assets.workspace_id` (`:105`) et `workspace_images.workspace_id` (`:113`) : **sans FK et sans
  index**, alors que toutes les requêtes filtrent dessus ⇒ lignes et fichiers orphelins.
- `pages.parent_id … ON DELETE SET NULL` (`:85`) : orphelinise la descendance à la racine au lieu
  d'échouer. `buildPagesTree` masque le symptôme ; pour l'utilisateur, des pages déménagent.
- `audit_events.workspace_id … ON DELETE SET NULL` (`:131`) + `routes/workspaces.ts:236-244` :
  l'événement `workspace_delete` **perd l'identité du workspace supprimé**.
- `page_documents.doc_id` (`:98`) : **aucune unicité**. N pages, y compris inter-workspace, peuvent
  pointer le même document. `routes/tickets.ts:51-58` résout le workspace par `.limit(1)`.
  Croisé avec `PATCH …/document` (`routes/page-documents.ts:135-212`), qui laisse tout membre
  réécrire `doc_id`/`lineage`/`sequence` : chemin inter-tenant inscrit dans le schéma.
- `pages.workspace_id`, `workspace_members.*` : FK sans `ON DELETE` ⇒ `RESTRICT` ⇒ 500 avec
  message Postgres brut.

### 6.3 Index

- Absents : `assets(workspace_id)`, `workspace_images(workspace_id)`,
  `workspace_invites(workspace_id)`, `workspace_invites(email)`, `pages(trashed)`,
  `(workspace_id, trashed)`, `(workspace_id, parent_id, sort_index)`, `sessions(expires_at)`.
- Redondant : `sessions_token_hash_idx` (`:53`) double la contrainte `UNIQUE` de `token_hash`
  (`:48`), qui crée déjà son index.
- Pas d'unicité partielle `workspace_invites(workspace_id, email) WHERE accepted_at IS NULL` :
  la garde de `routes/invites.ts:40-55` est une TOCTOU sans filet. Pas d'unicité
  `teamspaces(workspace_id, name)`.

Le Go pose `pages_workspace_id_id`, `page_purge_due … WHERE completed_at IS NULL`,
`workspace_notification_decision_cycle`.

### 6.4 Migrations

`src/db/apply-schema.ts:14-18` exécute le fichier SQL **hors transaction et sans advisory lock**.
La pile shell fait l'inverse (`src/shell/bootstrap.ts:32-34`) : `BEGIN` +
`pg_advisory_xact_lock(774839102)` + schéma dans la transaction — ce que réclame `schema.sql:2`.

Migration destructive inline rejouée à chaque boot sous `APPLY_SCHEMA_ON_BOOT=1` :
`UPDATE auth_challenges SET id = gen_random_uuid()` puis `DO $$ … DROP CONSTRAINT
auth_challenges_pkey … ADD PRIMARY KEY (id)`.

**Aucune table de versions.** Le Go maintient `schema_migrations` et conditionne ses backfills.
AFFiNE (Prisma migrate) et Docmost (migrations Kysely numérotées) sont versionnés.

`test/unit/architecture/service-node-schema-drift.test.ts` ne compare **jamais** les deux
`schema.sql` : six tables vérifiées et un plancher de douze tables Drizzle. La dérive de 34 tables
passe au vert.

### 6.5 Pool et transactions

- `src/db/pool.ts:8-12` : `max: 20`, `idleTimeoutMillis: 30_000`, et **ni
  `connectionTimeoutMillis`, ni `statement_timeout`, ni durée de vie max**. Vingt requêtes lentes
  gèlent le backend. Rien n'impose TLS.
- `src/auth/users.ts:7-12` : `SELECT` puis `INSERT` **sans `ON CONFLICT`** ⇒ violation de
  `users.email UNIQUE` remontée brute. La pile shell fait `ON CONFLICT(email) DO UPDATE`.
- `catch { await client.query('ROLLBACK'); throw error }` : si la connexion est morte, l'échec du
  `ROLLBACK` masque l'erreur d'origine. `shell/room-tickets.ts:96-102` fait mieux.

### 6.6 Ce qui est sain

- **Aucune injection SQL**, dans aucune des deux piles. Seul résidu : jokers `%`/`_` non échappés
  dans `ilike(pages.title, …)` — `q=%` matche tout, mais ce n'est pas une injection.
- **Aucune fuite de connexions de pool.**
- **Cryptographie des tickets correcte** : `timingSafeEqual`, en-tête JOSE canonique figé,
  base64url strict, `exp` refusé à l'égalité. `room-pass.ts` reproduit la parité lexicale du
  parsing JSON avec le Go.

---

## 7. Ce que Blok fait mieux

- **Spécification normative** : 1195 lignes, fixtures générées, huit comportements de durabilité
  énoncés normativement avec le test qui prouve chacun. Ni AFFiNE ni Docmost n'ont d'équivalent.
- **Un ack qui veut dire quelque chose** : opération, identifiant, digest, acteur authentifié et
  octets Yjs dans le store, à cette séquence, sans trou. AFFiNE ne donne aucun reçu ; le `synced`
  d'hocuspocus ne dit rien de la durabilité, et le debounce de Docmost peut coûter 45 s de travail.
- **Idempotence qui survit au redémarrage** : `operationId` + digest persistés dans le journal.
  AFFiNE fait du CAS sur timestamp (détecte le conflit, ne reconnaît pas le retry) ; Docmost rien.
- **Lignées, reset isolé, quarantaine** : un verdict d'écriture qui bascule en cours de frappe doit
  laisser le contenu *récupérable*. Rien de comparable ailleurs. (Réserve : §3.9.)
- **Pile shell sur la cohérence transactionnelle** : CAS versionné, outbox de purge, compensation
  d'upload, re-vérification d'accès poussée. Devant les deux références sur ce terrain.

---

## 8. Priorisation

| # | Action | Pourquoi | Effort |
|---|---|---|---|
| 1 | Rendre la pile « routes » indémarrable, ou corriger ses 7 failles critiques | 7 critiques derrière un `npm start` | minutes *ou* jours |
| 2 | Lancer la conformance contre la vraie salle Node | Sans S1–S8, aucune garantie de durabilité Node n'est vérifiée | jours |
| 3 | Ping/pong + expiration de présence | Seule faille de disponibilité exploitable sans privilège | heures |
| 4 | Cache court sur `principal()` | Débloque le débit sans toucher au modèle de sécurité | jours |
| 5 | Publier des checkpoints depuis Node | Lève la latence O(historique) et l'index non borné | jours |
| 6 | Store de quarantaine pour le participant Node | Débloque tout agent Node durable | jours |
| 7 | Remplacer `apps/service-node/schema.sql` par celui du Go | Ce que son en-tête demande | jours |
| 8 | Réarmer les tests de parité Go ↔ Node | Le script cible n'existe pas | jours |

Les points 2, 8 et la loi d'architecture manquante relèvent du même constat : côté Go, ce qui ne
doit pas régresser est *mécaniquement* protégé (un test parse l'AST pour vérifier qu'aucune requête
sur `pages` ne contourne le résolveur de permissions). Côté Node, rien — d'où le même modèle
réimplémenté quatre fois avec quatre comportements.

---

## 9. Vérifications proposées

Aucune n'a été exécutée. Chacune confirme un point coûteux à corriger.

1. `node scripts/test-server-conformance.mjs --target node` — quelles suites passent réellement.
2. Latence d'append sur des journaux de 10, 1 000 et 10 000 enregistrements.
3. Abandonner 32 sockets sans `close`, observer le 33ᵉ client.
4. `GET /api/documents/<doc-d-un-autre-workspace>/state` depuis une session membre du workspace A.
5. Suite shell avec `SHELL_TEST_DATABASE_URL` défini — sinon 18 `describe.skipIf` passent en
   silence et le vert est trompeur.
6. Appliquer les deux `schema.sql` sur des bases vierges, differ `pg_constraint` et `pg_indexes`.
7. Insérer `role = 'root'` dans `workspace_members` des deux côtés.
8. Démarrer un participant Node, observer son mode de stockage de quarantaine.
