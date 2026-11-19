# Prompt — terminer la migration des corps de lignes

Version complétée du prompt initial. Les ajouts sont mesurés sur l'instance
`blok.tousamba.cloud` (workspace `nexenture`) le 2026-11-19.

---

## Le travail

Dans `/Users/joce/.codex/worktrees/blok-lazy-row-bodies/blok`, branche
`feat/row-page-navigation`, terminer la migration des corps de lignes vers des
documents séparés.

Le script est `blokctl rows migrate <page-id> [--apply|--resume]`, dans
`apps/service/row_bodies_migration.go`. Sans option il simule. Il exige le service
arrêté et les anciens clients fermés. Dernier commit poussé : `658121f50` — il
ajoute la création et le déplacement de sous-pages dans les lignes par MCP, **pas**
cette migration. Aucun changement en production n'a été fait.

## L'ampleur réelle — mesurée, pas supposée

Sur les 188 pages du workspace, en rejouant les gardes de `planRowBodyMigration` :

```
migrable        386   déjà prêtes à migrer
existing-page   170   déjà migrées
nested-database  15   ← bloquées
nested-row        7   ← bloquées
```

**22 lignes bloquées sur 578, et elles tiennent sur deux pages :**

| page | lignes | bloquées |
|---|---|---|
| `Sprints` (l'ancienne) | 184 | `nested-database` = 14 (170 déjà migrées) |
| `Sprints (refonte)` | 8 | `nested-database` = 1, `nested-row` = 7 |

C'est une bonne nouvelle pour le risque : le périmètre est étroit, connu, et
**les deux pages sont régénérables par script** (voir « Plan de repli »). Aucun
autre document du workspace n'est concerné.

## Les cinq gardes, pas deux

`planRowBodyMigration` saute pour cinq motifs. Le prompt initial n'en citait que
deux. Il faut savoir lesquels sont légitimes :

| motif | ligne | à traiter ? |
|---|---|---|
| `nested-row` | 182 | **oui** — ligne dont un ancêtre est une `database-row` |
| `nested-database` | 226 | **oui** — un descendant est une `database` ou `database-row` |
| `existing-page` | 190 | non — déjà migrée, le saut est correct |
| `template` | 194 | non — un gabarit n'a pas de corps propre |
| `legacy-body` | 213 | **à arbitrer** — corps stocké dans les propriétés, ancien format. Aucune ligne du workspace ne tombe dedans aujourd'hui ; décider si on le traite ou si on le documente comme non supporté |

**Ne pas retirer les gardes sans traiter ce qu'elles protègent.** Concrètement,
pour `nested-database` : les lignes de la base imbriquée ont un `parentId` qui
pointe dans l'ancien document. Déplacer le corps de la ligne hôte sans déplacer
cette chaîne laisse des blocs orphelins. Même question pour les commentaires
ancrés sur un bloc déplacé, et pour les blocs `page` que le commit `658121f50`
permet désormais de poser dans une ligne.

## Le cas réel à faire passer

Document `Sprints (refonte)`, id `I1QcDCOjSH7EqjSpfLDPTPX4oiAJnOEIPh07R4YjNLY`.
Ligne `Sprint #1`, id `5958BKGKep`, base `fpe5rzCf72`. Elle n'a pas de
`data.pageId` et contient la base « Tâches », laquelle contient 7 lignes de tâche
— qui portent elles-mêmes du contenu, et dont l'une peut recevoir une sous-page.

C'est le cas complet : `nested-database` **et** `nested-row` imbriqués, avec du
contenu réel dans les deux niveaux. Son agrandissement utilise encore
`?row=…&database=…`.

## Ce que le prompt initial oubliait : les lignes futures

L'utilisateur l'a demandé, le prompt ne le portait pas :

> *il faudra aussi traiter les nouvelles lignes automatiquement pour éviter que le problème revienne*

**Sans ça, la migration est un coup d'épée dans l'eau** : chaque ligne créée
ensuite repart sans `data.pageId` et le problème réapparaît. Il faut donc, en plus
de la migration : soit créer le document de corps à la création de la ligne, soit
le créer à la première écriture dans le corps. Décider lequel, et le dire — une
création systématique fabrique un document par ligne, y compris pour les 386
lignes de tenants dont le corps restera vide à jamais.

**Vérifié sur l'instance, après `658121f50`** : une ligne créée aujourd'hui via
`database.addRow`, puis remplie d'un paragraphe **et** d'une base imbriquée dans
son corps, n'a toujours **pas** de `data.pageId` :

```
data : {"properties":{…},"position":"a01749","title":""}
enfants du corps : ["paragraph","database"]
```

Conséquence directe : **régénérer un document de zéro ne contourne pas la
migration.** Une page « Sprints (refonte) » reconstruite aujourd'hui retomberait
exactement sur les mêmes 1 `nested-database` + 7 `nested-row`. Le volet « lignes
futures » n'est donc pas une amélioration : sans lui, le parc se re-salit au
rythme des créations.

À noter : `658121f50` permet de poser une **sous-page** dans le corps d'une ligne
(et cela fonctionne, `location.rows` est correct) — mais le corps de la ligne
lui-même reste des blocs enfants du document hôte. Ce sont deux mécanismes
distincts, ne pas conclure de l'un à l'autre.

## Critère de succès — vérifiable, pas « correctement »

La migration est réussie quand, service redémarré :

1. `blokctl rows migrate <page-id>` (simulation) rapporte `skipped: []` pour les
   deux pages, et un plan non vide.
2. Chaque ligne migrée porte un `data.pageId`, et ce document contient son ancien
   corps : blocs, bases imbriquées, sous-pages, commentaires.
3. `blok_list_pages` renvoie pour chaque sous-page un champ **`location.rows`**
   portant le chemin complet. Exemple attendu pour la sous-page « Commits » :
   ```json
   "location": { "blockId": "5958BKGKep",
                 "rows": [{ "rowId": "5958BKGKep", "databaseId": "fpe5rzCf72",
                            "title": "Sprint #1", "icon": "🏁" }] }
   ```
   Pour une tâche, `rows` doit porter **deux** entrées : le sprint puis la tâche.
4. L'URL d'une ligne n'est plus `?row=…&database=…` mais une URL de page.
5. Les 4 tests existants de `row_bodies_migration_test.go` passent toujours :
   `TestRowBodyMigrationReportsSkippedRowsAndDryRunDoesNotTransfer`,
   `TestRowBodyMaintenanceResetPreservesPreparedSource`,
   `TestRowBodyMaintenanceEndpointDoesNotFreezeOtherDocuments`,
   `TestRowBodyMigrationLeavesUnconvertedLegacyBlobsInline`.
6. `--resume` après interruption ne crée aucun doublon (déjà couvert par le
   commit `658121f50` côté MCP ; à re-vérifier ici).

## Piège de vérification — à connaître avant de conclure

**L'index des pages n'est pas mis à jour immédiatement.** Mesuré aujourd'hui :
une sous-page créée par MCP a, juste après sa création, `location: undefined` et
`title: "Nouvelle page"` dans `blok_list_pages` — à **toutes** les profondeurs,
pas seulement les imbriquées. Les bonnes valeurs apparaissent plus tard.

Conséquence : **ne pas conclure que la migration a échoué en lisant l'index juste
après.** Vérifier à froid, après redémarrage, ou lire la structure dans le
document (`blok_read`) plutôt que dans l'index. C'est exactement l'erreur que
cette session a failli commettre.

Il faut aussi décider si ce différé est voulu (indexation par lot) ou s'il doit
être corrigé — un client qui lit `location` après création croit la hiérarchie
cassée.

## Plan de repli

Les deux seules pages concernées sont régénérables :

- `Sprints (refonte)` : `node ~/Desktop/blok-tousamba/out/commits-base.mjs`,
  `out/enrichir-commits.mjs`, `out/velocite.mjs`, `out/capacite.mjs` — l'ensemble
  reconstruit la page en quelques minutes à partir de `out/*.json`.
- `Sprints` (l'ancienne) est un reliquat, remplacé par la refonte.

Donc : sauvegarde de la base avant `--apply`, et si la migration abîme l'une des
deux, on régénère plutôt qu'on répare. Cela autorise une migration plus franche
sur ces deux documents que sur du contenu rédigé à la main.

**Attention** : les 386 lignes `migrable` incluent la page `Tenants` (153 lignes
avec descriptions, logos et secteurs saisis à la main) et les pages d'équipe.
Celles-là ne sont **pas** régénérables à l'identique. La prudence vaut pour
elles, pas pour les deux pages Sprints.

## Ordre d'exécution en production

1. Sauvegarde de la base de données.
2. Arrêt du service, fermeture des clients ouverts.
3. `blokctl rows migrate <page-id>` — simulation, lire le rapport, vérifier
   `skipped: []`.
4. `--apply`.
5. Redémarrage, puis les vérifications 2 à 4 du critère de succès.
6. Recommencer page par page, en finissant par celles qui ne sont pas
   régénérables.

## Contraintes du dépôt

- **TDD, dans cet ordre** (`CLAUDE.md`) : écrire le test, **le voir échouer**,
  puis écrire le code. Un test écrit après coup ne prouve rien. Le cas
  `nested-database` doit avoir son test rouge avant toute modification de
  `planRowBodyMigration`.
- **Pas de parité Go/C#/Rust ici** : `apps/service` est hors `packages/server`,
  la loi de parité ne s'applique pas à ce fichier. Ne pas écrire de pendant C# ou
  Rust pour cette migration.
- `vitest` **ne vérifie pas les types** : une erreur de type passe les tests et
  casse le build Docker (`tsc --noEmit`). Vu une fois dans cette session.
- **`tsc` et ESLint épuisent le tas V8** sur le cœur dans ce worktree. **Ne pas
  augmenter les limites mémoire** (instruction utilisateur explicite) : le
  signaler plutôt que contourner.
- Vérifications ciblées, **une seule à la fois**, avec
  `python3 scripts/low-memory.py`.
- Ne pas modifier `vite.config.mjs`, `vitest.config.ts`, `tsconfig.json`,
  `eslint.config.mjs`, `package.json`.
- **Ne pas lancer `--apply` en production.** Préparer, tester, puis fournir les
  commandes à l'utilisateur.

## Fichiers

| Fichier | Rôle |
|---|---|
| `apps/service/row_bodies_migration.go` | le script — gardes lignes 182-226, modes lignes 249-356 |
| `apps/service/row_bodies.go` | les primitives de corps de ligne |
| `apps/service/row_bodies_migration_test.go` | les 4 tests à ne pas casser |
| `desktop/src/page-urls.ts` | `rowPageDestination`, `rememberResolvedRowPage` |
| `desktop/src/workspace.ts` ~312-330 | résolution de la route et `openRow` |
| `apps/service/page_locations.go` | « *Location is a read-only projection of the block tree* » |
| `apps/service/page_urls.go` | résolution serveur ; `rowBodyOf` |
