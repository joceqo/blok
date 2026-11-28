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

## État au 26 novembre 2026, en fin de journée

`packages/server/node` : 46 fichiers de test, **338 tests verts**.
Conformance `--target node` : **439 verts sur 528** (83 %), contre 333 le matin même.
Plus aucun test sauté : les 109 qui ne démarraient pas s'exécutent.

Fait avant cette journée : ping/pong 30 s, memo d'autorisation, registre de rooms partagé,
publication de checkpoints, upgrade WebSocket sur l'hôte (`protocol-v2-contract` 14/14).

Fait ce jour :

- **`POST /sync/{doc}/edit` répond.** La suite `collab-http-contract` passe de 0 test passant
  à 95 sur 117. Par ricochet, `host-cli-contract` tombe de 11 à 5 échecs et
  `page-transfer-sidecar` de 6 à 3 — elles amorçaient leurs documents par cette route.
- **Le convertisseur canonique est conforme à 100 % de sa fixture** : 18 formes canoniques,
  18 condensés, 13 clés, les 74 refus mot pour mot, et les 50 doubles .NET.
- Deux bugs de production corrigés : le délai de requête qui détruisait toute session
  collaborative à dix minutes, et la fenêtre du bureau qui devenait impossible à fermer.
- **La CI garde enfin l'hôte Node**, avec un cliquet sur quatre suites (252 tests).

Trois règles apprises de la fixture et qu'aucune lecture du Go ne donne :

- un double atteint le condensé écrit à la .NET, pas à la JS — JS bascule en exponentiel à 1e21
  et 1e-7, .NET dès 1e17 et 1e-5, et JS écrit « 0 » pour moins zéro. 23 des 50 cas en dépendent ;
- les clés se trient par unité UTF-16, et l'échappement est celui de `JavaScriptEncoder.Default` ;
- entre un NUL et un octet illisible, le départage se fait **op par op** : dans une même op, un
  nom que le décodeur n'a pas su lire précède son NUL ; une op plus loin n'est jamais atteinte.

## Ce qu'il reste, par ordre

1. **`sync-transport-contract`** (22 rouges sur 42). **Correction d'une erreur de ce brief :
   ce n'est PAS du portage depuis `preview.ts`.** Vérification faite ligne par ligne,
   `preview.ts` n'a aucun plafond de sockets par document — seulement un compteur global
   d'admissions à 256 — ni analyse de sous-protocole conforme, ni 426, ni 405, ni limiteur.
   À l'inverse, `src/host/sync-room.ts` a **déjà** le plafond de 8 sockets par membre et par
   document, le limiteur partagé et les closes 4400/4401, et `src/host/sync-door.ts` a déjà le
   426, le trim Unicode et la sélection v1/v2. Les deux « défenses prioritaires » que ce brief
   désignait existent donc depuis longtemps.
   La source d'autorité est l'hôte **.NET** : `packages/server/dotnet/Blok.Server.AspNetCore/Collab/`.
   Ce qui manque réellement est le **budget entrant par connexion** (`SyncInboundBudget.cs`) :
   réceptions par message, trames, amplificateurs, octets de présence — quatre compteurs qui
   ferment en `1008 inbound rate exceeded`, chaîne absente du Node. Sans eux un seul client
   sature une salle. Suspect pour les douze cas RFC 6455 : `document-room.ts` détruit la socket
   sur `error`, or `ws` écrit la trame de fermeture **puis** émet l'erreur.
2. **`sync-contract` (15/16) et `blok-client-contract` (12/12).** Deux suites quasi intégralement
   rouges, ce qui sent la cause unique plutôt que vingt-sept défauts. Indice relevé : le client
   négocie `protocol=v1` alors que le serveur annonce un tag format 2, et la poignée de main
   réussit avant que plus rien ne vienne. Vérifier si `selectSubprotocol` dépend de
   `collabJournal` et comment la conformance lance le serveur.
3. **Les 22 rouges restants de `collab-http-contract`**, à regrouper par cause.
4. **Brancher l'estampillage d'autorité** (`src/collab/edit/stamp.ts`, écrit et testé, inerte).
   À trancher au branchement : l'applicateur crédite déjà les mises à jour, le crédit serait
   écrit deux fois.
5. **Supprimer la pile « routes »** — d'abord repointer les 9 suites de
   `test/unit/service-conformance/` vers `createShellApp`, sinon la migration perd son filet.
6. **Vendoriser le schéma Go** dans `apps/service-node`.
7. **Une loi d'architecture côté Node**, équivalente à `permissions_law_test.go`.
8. **Sortir `inspectJournal` du chemin d'écriture** (`append.ts`) : chaque frappe relit et rejoue
   encore une fenêtre de journal.

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
  de 10 s (`raw-websocket.ts:300-302`). 89 échecs = 244 s de run ; une suite verte seule = quelques
  secondes. Le run complet se mesure donc en échecs, pas en tests.
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
