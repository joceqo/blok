# Une ligne imbriquée n'est pas atteignable par son URL

Prompt pour l'IA qui reprend ce bug. Écrit le 2026-11-18 sur la branche
`feat/row-page-navigation`, après un premier correctif **incomplet** (`6e02848c9`).

## Le produit

Blok est un éditeur par blocs (type Notion). Loi d'architecture, dans
`CLAUDE.md` : **tout est un bloc**. Une base de données est un bloc, une ligne
de base est un bloc `database-row`, et le corps d'une ligne est constitué de
ses blocs enfants. Donc une ligne *est* une page, et doit être adressable par
une URL comme n'importe quelle page — **à n'importe quelle profondeur**.

L'instance de test : `blok.tousamba.cloud`, workspace `nexenture`.

## Le symptôme

Structure reproduisant le cas, sur une page « Sprints » :

```
page « Sprints »
└── database « Sprints »              (bloc racine du document)
    └── database-row « Sprint #1 »
        └── database « Tâches »       ← imbriquée dans le corps de la ligne
            └── database-row « [BZB] Assignation… »
```

Deux comportements observés, tous deux reproductibles :

1. **Ouvrir une tâche en pleine page.** Depuis la page du Sprint #1, on ouvre
   la tâche en aperçu (ça marche), puis on clique « pleine page ». L'URL
   devient `?row=<idTâche>&database=<idBaseTâches>`, le fil d'Ariane affiche
   bien le titre de la tâche — **mais le canvas affiche la table Sprints**.
   Idem en arrivant directement sur l'URL canonique `/p/<slug>-<publicId>`
   d'une tâche.

2. **Cliquer « OUVRIR » sur une tâche depuis l'aperçu du sprint.** Tout se
   ferme et on revient à la page racine.

Conséquence : avec ce modèle de données (les tâches vivent dans la page de leur
sprint), **aucune tâche n'est atteignable par son URL**.

## Analyse

Il y a **deux chemins** qui ouvrent une ligne, et c'est la source de la
confusion. Le correctif déjà en place n'en traite qu'un, et probablement pas
le bon.

### Chemin A — le cœur, `src/tools/database/index.ts`

`followRowPageHistory` (~ligne 9876) lit la route via
`this.config.rowPages?.navigation?.current()` et décide d'ouvrir ou de fermer.

Le défaut : la route porte un `databaseId`. La base **racine** le compare au
sien, ne le reconnaît pas, conclut « cette route ne me concerne pas » et
**ferme son drawer** — alors que ce drawer est précisément ce qui monterait la
base imbriquée capable d'ouvrir la ligne.

**Ce qui a été corrigé dans `6e02848c9` :** une méthode `hostingRow(databaseId)`
remonte, via `nearestRow`, de la base visée jusqu'à la ligne de *cette* base
qui l'héberge, et l'ouvre au lieu de fermer. La base imbriquée, une fois
montée, exécute le même code et termine le trajet — donc la profondeur est
quelconque. Deux détails qui ont coûté deux itérations :

- la recherche doit passer **avant** le retour anticipé `if (shownFull ===
  wanted) return;` : au chargement à froid les deux valent `null` et tout le
  cas était avalé là ;
- `handleRowClick` renavigue si la route ne désigne pas la ligne qu'on ouvre.
  `hostRoute` a donc été étendu : une route visant un descendant de la ligne
  compte comme déjà honorée, sinon l'ouverture écrase la destination.

Tests : `test/unit/tools/database/nested-row-routing.test.ts` — un test du cas
imbriqué, un test qui vérifie qu'une route étrangère ferme toujours le drawer.

**Mais `followRowPageHistory` n'est branché que sur `popstate`**
(`index.ts:2991`). Il ne tourne donc ni au chargement initial, ni sur une
navigation interne (qui passe par `history.pushState` + `onRoute()`). Le test
déclenche `popstate` à la main — **il valide la logique, pas le chemin réel**.

### Chemin B — le desktop, `desktop/src/workspace.ts` (~lignes 312-330)

C'est celui qu'emprunte l'application en vrai, au chargement **et** sur
navigation interne :

```js
const row = session.editor.blocks.getById(route.rowId);
const databaseId = route.databaseId ?? row?.parentId;
const database = databaseId ? session.editor.blocks.getById(databaseId) : undefined;
if (!row || row.name !== 'database-row' || !database || database.name !== 'database'
    || row.parentId !== database.id || …) {
  clearRowPresentation(); showUnavailablePage(); return;
}
database.call('openRow', { rowId: route.rowId, mode: 'full', explicit: true });
```

**C'est très probablement ici que le bug se joue.** `blocks.getById` retrouve
bien les deux blocs — ils existent dans le document même imbriqués — mais la
base « Tâches » se trouve dans le corps d'une ligne **non ouverte**, donc son
*tool* n'est pas monté : `database.call('openRow', …)` ne déclenche rien, et on
reste sur le document hôte. Aucun garde-fou ne détecte ce cas.

**À vérifier en premier**, avant toute écriture de code : instrumenter ce bloc
sur l'instance déployée et constater si `call('openRow')` est bien sans effet.
Si oui, le correctif appartient ici — ouvrir d'abord la chaîne des lignes
ancêtres, puis la ligne demandée — et le correctif du chemin A n'est qu'un
complément.

## Ce qu'il faut livrer

1. Une ligne est atteignable par son URL **à toute profondeur**, au chargement
   à froid comme en navigation interne, en avant comme en arrière.
2. Le fil d'Ariane, le titre de l'onglet et le contenu du canvas désignent la
   **même** page. Aujourd'hui les deux premiers sont corrects et le troisième
   non, ce qui rend le bug discret et dangereux : on croit éditer la tâche, on
   écrit dans le document hôte.
3. Retour arrière et avant cohérents sur toute la chaîne.
4. Une route réellement étrangère doit continuer à fermer le drawer — ne pas
   transformer le correctif en « n'importe quelle route ouvre n'importe quoi ».

## Contraintes du dépôt

- **TDD, non négociable** (`CLAUDE.md`) : écrire le test, le voir **échouer**,
  puis écrire le code. Un test écrit après coup ne prouve rien.
- **Piège vécu sur ce bug** : un test qui reproduit une structure *inventée*
  passe au vert sans rien démontrer. Partir de la structure réelle, lue dans le
  document (via le MCP `blok_open` / `blok_read`, ou le DOM de la page
  déployée), pas d'une structure supposée.
- **`vitest` ne vérifie pas les types.** Une erreur de type passe les tests et
  casse le build Docker (`tsc --noEmit`). Vu une fois dans la session.
- **`tsc` et ESLint épuisent le tas V8** sur le cœur dans ce worktree.
  **Ne pas augmenter les limites de mémoire** (instruction utilisateur
  explicite) : le signaler plutôt que de contourner.
- Lancer les tests avec `python3 scripts/low-memory.py core-test <fichiers>`.
  Un seul travail lourd à la fois sur cette machine.
- `test/unit/tools/database/row-page-peek.integration.test.ts` a **2 échecs
  préexistants**, vérifiés sans le correctif. Ne pas les attribuer au travail
  en cours.

## Points d'entrée

| Fichier | Rôle |
|---|---|
| `desktop/src/workspace.ts` ~312-330 | **chemin réel** : résolution de la route et `openRow` |
| `desktop/src/page-urls.ts` | `rowPageDestination`, `rememberResolvedRowPage` |
| `src/tools/database/index.ts` ~9876 | `followRowPageHistory` (popstate seulement) |
| `src/tools/database/index.ts` ~1297 | `nearestRow` — remonte à la `database-row` la plus proche |
| `src/tools/database/database-card-drawer.ts` ~823 | `hasFullPageChild` |
| `apps/service/page_urls.go` | résolution serveur ; renvoie `rowBodyOf: {documentId, rowId}` |

**Note sur le serveur** : `rowBodyOf` ne contient **pas** de `databaseId`. Pour
une URL canonique, le client ne sait donc pas quelle base vise la route et doit
la déduire du document. C'est peut-être le vrai manque — à arbitrer : enrichir
la réponse serveur, ou faire la déduction côté client.

## Vérifier sur l'instance

Page de test (privée, jetable, régénérable par
`node ~/Desktop/blok-tousamba/out/sprint-v2.mjs`) :
`https://blok.tousamba.cloud/p/sprints-refonte-b3f6e1bf-abf8-4ce8-b35f-b18be5394167`

Elle contient une base « Sprints », une ligne « Sprint #1 », et dans son corps
une base « Tâches » de 7 lignes — exactement la structure du bug.
