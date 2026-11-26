# Brief : backend Node et shell

Prompt de démarrage pour une session fresh. À coller tel quel, ou à faire lire en premier.

---

## Le contexte en six lignes

Blok est un éditeur de blocs collaboratif auto-hébergeable (type Notion). Le dépôt est un fork :
`origin` = `joceqo/blok`, `upstream` = `JackUait/blok`. Le backend produit existe **deux fois** :
en Go (`apps/service`, la référence historique) et en Node/TypeScript (`apps/service-node`, la
réécriture). **La direction est actée : Node/TS devient l'implémentation.** Le Go sera retiré.

La parité multi-langages (Go / C# / Rust / Node sur `packages/server`) **n'est plus un objectif
pour le travail à venir**. On garde l'existant, on ne le fait plus évoluer en parallèle.

## Ce qu'il faut savoir avant de toucher quoi que ce soit

**`apps/service-node` contient deux backends.** Un seul est démarré.

| | Pile « shell » | Pile « routes » |
|---|---|---|
| Entrée | `src/shell/main.ts` | `src/app.ts` + `src/routes/*` |
| Démarrée par | `npm start`, le Dockerfile | **rien** |
| Base | `pg` brut, schéma Go | Drizzle, `apps/service-node/schema.sql` |
| Qualité | transactions, `FOR UPDATE`, `SERIALIZABLE`, ~20 tests d'intégration | quasi pas de transactions, aucun test de route |

La pile « routes » est compilée, exportée, et instanciée par la suite de conformance de service.
Elle porte **sept failles critiques** (voir `docs/backend-node-vs-affine-docmost.md`). Elle n'a pas
d'avenir : son schéma est incompatible avec celui que le Dockerfile déploie.

**`packages/server/node` contient deux serveurs.** L'hôte HTTP (`src/main.ts` → `bin/blok-server.mjs`)
et la salle temps réel (`src/collab/room/preview.ts` → `bin/blok-journal-room.mjs`). Depuis
novembre 2026, l'hôte sait aussi héberger la salle (`src/host/sync-room.ts`).

## L'objectif

Un backend Node propre et un shell propre, c'est-à-dire :

1. **Une seule pile** dans `apps/service-node`. La « shell » gagne, la « routes » disparaît.
2. **Un seul schéma** : celui du Go (`apps/service/schema.sql`), que le Dockerfile copie déjà.
   `apps/service-node/schema.sql` est un brouillon qui le dit lui-même en ligne 1 ; il lui manque
   34 tables, tous les `CHECK`, `page_shares`, `pages.visibility` et le compteur d'essais de login.
3. **Le modèle de permissions écrit une seule fois.** Il est aujourd'hui réimplémenté en SQL
   récursif dans quatre endroits, avec des écarts. Le Go l'interdit par une loi d'architecture
   (`permissions_law_test.go` parse l'AST de tous les fichiers) ; côté Node, rien n'empêche la dérive.
4. **La conformance qui passe** contre le serveur Node.

## État au 26 novembre 2026

Fait et testé (`packages/server/node` : 35 fichiers de test, 271 tests verts) :

- ping/pong 30 s — les sockets mortes libèrent leur slot et leur entrée de présence
- memo d'autorisation — 32 destinataires coûtaient 32 appels HTTP par frappe, maintenant un seul ;
  le push sur `/internal/room/recheck-access` reste l'autorité et invalide
- registre de rooms extrait et partagé entre la salle et l'hôte
- publication de checkpoints (64 opérations ou 1 MiB, les défauts du Go) — le replay ne rejoue plus
  toute la lignée
- upgrade WebSocket sur l'hôte : **`protocol-v2-contract` passe 14/14** (0/14 avant)

## Ce qu'il reste, par ordre

1. **`src/http/conn.ts:190-199` — bug de production.** Chaque handler est enveloppé dans un
   `Promise.race` avec `requestTimeoutMs` (600 s). Un handler WebSocket ne rend jamais la main :
   **toute session collaborative meurt à dix minutes.** Invisible en conformance (tests de quelques
   secondes). Le hook existe à moitié : `exchange.hijacked` est un `Notify` déclaré dans
   `exchange.ts:65` que **personne ne notifie**. Il faut le déclencher dans `hijack()`
   (`response.ts:118`) et désarmer le timer dans `conn.ts`.
2. **`src/collab/room/document-room-apply.fast.test.ts` — 9 tests rouges, volontaires.** Ils
   décrivent la porte d'écriture que `POST /sync/{doc}/edit` attend dans la salle, écrits avant le
   code puis interrompus. Les faire passer débloque les 40 tests de `collab-http-contract` : les
   11 suites du fichier amorcent toutes leur document par `/edit`, il n'existe aucun îlot contournable.
3. **`sync-transport-contract`** (~31 rouges). Priorité au plafond de 8 sockets par document et au
   rate limit partagé : ce sont de vraies défenses anti-déni-de-service. Les codes 426/405 et le
   parsing des sous-protocoles sont cosmétiques. **C'est du portage, pas de l'invention** :
   `preview.ts` implémente déjà origine, sous-protocoles, plafonds et admission.
4. **Supprimer la pile « routes »** — mais d'abord repointer les 9 suites de
   `test/unit/service-conformance/` vers `createShellApp`, sinon la migration perd son filet.
5. **Vendoriser le schéma Go** dans `apps/service-node`.
6. **Une loi d'architecture côté Node**, équivalente à `permissions_law_test.go`.

## Règles du dépôt, non négociables

- **IRON RULE** : écrire le test D'ABORD, le voir **échouer**, puis le code. Pour un bug : test de
  régression avant le correctif.
- Les tests de conformance (`test/**`) sont la **spécification**. On ne les modifie jamais pour les
  faire passer. Un test qui paraît faux se signale, il ne se contourne pas.
- Ne jamais dupliquer une règle entre `preview.ts` et l'hôte. Factoriser ou demander l'arbitrage.
- `~1012 erreurs de typecheck` sont **préexistantes** dans le projet. Ne pas les corriger en
  passant, ne pas en ajouter. Vérifier la responsabilité avec `git diff --name-only` avant de
  conclure qu'un échec est le sien.

## Pièges mesurés, qui font perdre des heures

- **Les tests de conformance ne sont pas lents, les échecs le sont.** Chaque attente a un timeout
  de 10 s (`raw-websocket.ts:300-302`). 103 échecs = 545 s de run ; la suite verte seule = 38 s.
  Toujours itérer avec `--suite <nom>` et `--test-name-pattern "<cas>"`. Le runner échoue
  volontairement si le pattern ne sélectionne rien : c'est une protection contre le faux vert.
- **Un octet NUL écrit en brut rend un fichier invisible à grep** (`file` le classe en « data »).
  C'est arrivé dans `sync-room.ts` et a fait croire à du code disparu. Écrire `\0`.
- **Un mot d'écart casse neuf tests.** Les suites utilisent la fermeture `1003 binary frames only`
  comme sonde de vie : elles envoient une frame texte et vérifient la raison exacte. Un test qui
  portait sur tout autre chose échoue alors sur la chaîne.
- **Lancer plusieurs agents sur `src/host/` sans répartition écrite = ils s'écrasent.** Assigner les
  fichiers nommément, et n'autoriser que des éditions chirurgicales sur les fichiers partagés
  (`map-routes.ts`, `main.ts`).

## Les deux références, et ce qu'on leur prend

Lire `docs/backend-node-vs-affine-docmost.md` pour le détail chiffré.

| Problème | Qui a la réponse | Ce qu'on prend |
|---|---|---|
| Coût du replay | **AFFiNE** | séparer le journal (vérité) de l'état matérialisé (reconstructible) |
| ACL dans la boucle chaude | **AFFiNE** | revalidation événementielle + génération anti-TOCTOU |
| Scaling horizontal | **Docmost** | lock Redis par document + proxy de socket ; même invariant qu'aujourd'hui, au niveau cluster |
| Quarantaine côté participant Node | **le Go du dépôt** | `packages/server/go/blokmcp/room.go`, avec un store SQLite ou fichiers — pas IndexedDB |
| Dérive des permissions | **le Go du dépôt** | `permissions_law_test.go`, transposé en TS |

Ce qu'on ne prend à personne : le debounce de Docmost (10 s, max 45 s) — incompatible avec l'ack
durable, ce serait régresser sur le seul avantage que Blok a sur les deux.

## Ce que Blok a et qu'ils n'ont pas

À ne pas sacrifier en cherchant à simplifier : une spécification normative de 1195 lignes avec
fixtures générées et huit scénarios de durabilité exécutables ; un ack qui signifie « sur disque, à
cette séquence, sans trou » ; une idempotence persistée qui survit au redémarrage ; des lignées avec
reset isolé et quarantaine. AFFiNE ne donne aucun reçu ; le `synced` d'hocuspocus ne dit rien de la
durabilité, et le debounce de Docmost peut coûter 45 secondes de travail à un `kill -9`.
