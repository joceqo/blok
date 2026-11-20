# Une ligne n'est pas une page — et l'édition ralentit avec le document

Écrit le 2026-11-19 sur `feat/row-page-navigation`. Deux sujets, séparés, mesurés
sur l'instance `blok.tousamba.cloud` (workspace `nexenture`). Aucun correctif
appliqué : les deux touchent le cœur, et le second demande un profil CPU.

Ce document remplace et englobe `docs/nested-row-routing-bug.md` et
`docs/mcp-sous-pages.md` pour la partie hiérarchie : les symptômes qu'ils
décrivent sont le même manque vu sous quatre angles.

---

# Partie 1 — Une ligne devrait pouvoir être parente

## La loi, et sa moitié manquante

`CLAUDE.md` pose : **tout est un bloc**, une ligne de base est un bloc
`database-row`, et le corps d'une ligne est constitué de ses blocs enfants. Donc
une ligne *est* une page.

C'est vrai dans le document. Ce n'est pas vrai dans l'index des pages.

## Ce que Notion fait, pour comparaison

Chez Notion, chaque élément de base est une page de plein droit. Sous la zone des
propriétés se trouve de l'espace libre où l'on peut poser n'importe quel bloc, **y
compris des sous-pages**. Et l'API distingue explicitement les deux rôles :

```json
{ "parent": { "database_id": "…" } }              → une LIGNE de cette base
{ "parent": { "page_id": "<id de la ligne>" } }   → une SOUS-PAGE dans cette ligne
```

Une ligne agit donc comme un parent de page ordinaire. (À ne pas confondre avec
les sous-items d'une base, qui sont une relation réflexive — de la hiérarchie
entre lignes, pas de l'imbrication de contenu.)

Références : [Intro to databases](https://www.notion.com/help/intro-to-databases),
[Create a page](https://developers.notion.com/reference/post-page),
[Parent object](https://developers.notion.com/reference/parent-object).

## Ce que Blok fait, mesuré

Structure réelle, page « Sprints (refonte) », ligne `5958BKGKep` (Sprint #1) :

```
index des pages du workspace
  « Sprints (refonte) »   id=I1QcDCOjSH7E…   parentId = AUCUN
  « Commits »             id=TvEmzznXq6mK…   parentId = I1QcDCOjSH7E…   ← la PAGE, pas la ligne

dans le document
  bloc page      KF5_UoLjgN    parentId = 5958BKGKep    ← la LIGNE
  ligne          5958BKGKep    database-row  parentId = fpe5rzCf72
  base           fpe5rzCf72    database      parentId = racine
```

Les deux hiérarchies divergent. Ce qui marche et ce qui ne marche pas :

| appel | résultat |
|---|---|
| `block.insert { type:'page', parentId:'<rowId>' }` | ✅ le bloc page est bien dans le corps de la ligne |
| `blok_create_page { parentId:'<rowId>' }` | ❌ `parent unavailable` |
| `blok_move_page { parentId:'<rowId>' }` | ❌ `Destination not found` |
| `parentId` de la page dans l'index | ❌ remonte à la page hôte, la ligne saute |

## Les quatre symptômes, qui n'en font qu'un

1. **Le fil d'Ariane saute le Sprint #1.** `blok_list_pages` ne peut pas nommer la
   ligne : elle n'est pas une page. La description de l'outil annonce pourtant un
   champ censé combler ça — « *location.rows is its authorized row breadcrumb
   path* » — mais **`location` est absent de la réponse** observée.

2. **Double chrome en pleine page.** Sur `?row=…&database=…`, le mode vaut déjà
   `full` : `database-card-drawer.ts:2587` cache alors `peek-expand`,
   `peek-mode`, `peek-prev/next` (« *A full page has no mode switcher and no row
   steps (R17)* »). Mais la page reste rendue **dans l'habillage du drawer**,
   d'où un bouton « Retour » et deux fils d'Ariane superposés :
   `Nexenture / Sprints (refonte) / Sprint #1` puis `‹ Sprints / Sprint #1`.
   Chez Notion, une page pleine n'a plus aucun habillage de peek.

3. **Une ligne imbriquée n'est pas atteignable par son URL** — le sujet de
   `docs/nested-row-routing-bug.md`. La résolution d'URL ne sait pas désigner une
   ligne, elle rejoue l'ouverture de son hôte.

4. **Le MCP ne créait pas de sous-pages** — `docs/mcp-sous-pages.md`. Corrigé
   depuis côté MCP, mais la page créée reste rattachée à l'hôte, pas à la ligne.

## Ce qu'il faudrait livrer

Inscrire la ligne dans l'index des pages, avec la base pour parent, et l'accepter
comme `parentId`. C'est le modèle Notion, et il rend cohérents d'un coup :
`create_page`, `move_page`, le fil d'Ariane, le routage d'URL et le choix du mode
d'ouverture.

Point d'arbitrage, à trancher avant d'écrire : Notion règle le mode d'ouverture
**par vue de base** (••• → Layout → « Open pages as » : side peek / center peek /
full page), avec `Cmd+clic` pour forcer la pleine page. Blok a déjà les trois
modes et le bouton de bascule — il lui manque le réglage persistant par vue.

---

# Partie 2 — L'édition ralentit, et ce n'est ni le réseau ni le rendu

## Le protocole

Même phrase de 39 caractères tapée dans un paragraphe, sur deux pages. Latence
mesurée du `keydown` jusqu'à la deuxième `requestAnimationFrame` (donc après
peinture). Tâches longues via `PerformanceObserver({ entryTypes: ['longtask'] })`.

## Le résultat

```
                           page « Commits »      page légère        écart
                           (base de 140 lignes)  (4 blocs)
latence de frappe médiane       2 822 ms            228 ms          ×12
             p90                5 107 ms            406 ms          ×13
             max                5 479 ms            450 ms
tâches longues            10 · 6 237 ms total   1 · 410 ms total    ×15
  la pire                       5 207 ms            410 ms
nœuds DOM                        15 234             2 576           ×6
```

Le JS bloquant croît **plus vite que le DOM** : ×15 pour ×6.

## Ce que ce n'est pas

Trois suspects écartés par la mesure, sur une série de 10 frappes :

| suspect | mesure | verdict |
|---|---|---|
| le réseau / la synchro | **4 envois WebSocket, 878 octets au total** | hors de cause — la synchro est bien incrémentale |
| la persistance locale | **8 écritures IndexedDB** (4 `updates`, 4 `outbox`) | hors de cause |
| le rendu DOM | **26 mutations par frappe**, et **aucune dans la base** | hors de cause — la virtualisation fonctionne, 7 lignes rendues sur 140 |
| le chargement | `domInteractive` **192 ms**, transfert **22 ms** | excellent — ce n'est pas le chargement qui est lent |

## Ce que c'est

Du **JavaScript synchrone sur le fil principal** : ~100 ms par frappe, plus un pic
isolé de 1 087 ms (attribution `window`, donc pas une iframe). Il ne produit
presque aucune mutation DOM et n'écrit presque rien — il *calcule*.

Détail qui oriente : sur 10 frappes, **57 mutations touchent la barre latérale**,
qui n'a aucun rapport avec le paragraphe édité. Quelque chose se réévalue
globalement à chaque caractère.

C'est le même motif que côté serveur, déjà mesuré sur ce worktree : `blok_execute`
coûte ~2,9 s **quel que soit le nombre de commandes**, dont 2 844 ms de
`runtime_execute` à re-sérialiser le document (627 blocs, 364 Ko) pour 7,6 ms de
travail réel (`apply_ops`). Un coût en O(taille du document) payé par opération,
des deux côtés.

## Par où commencer

1. **Un profil CPU de 10 frappes** sur cette page, pour nommer la fonction. Les
   mesures ci-dessus disent où ce n'est pas ; elles ne nomment pas le coupable.
2. Chercher ce qui, à chaque frappe, parcourt le document entier plutôt que le
   bloc touché — et pourquoi la barre latérale mute.
3. Vérifier si le coût suit le nombre de **blocs du document** ou de **nœuds DOM**
   (la page « Commits » n'a qu'une vingtaine de blocs propres : la base gère ses
   lignes, donc la piste DOM est la plus probable).

## Reproduire

Page de test : `https://blok.tousamba.cloud/p/commits-6713c43c-6999-4374-b9a8-4a18095b272c`
— ~20 blocs propres plus une base de 140 lignes groupée par chantier. Taper dans
le paragraphe d'introduction suffit à voir la latence.

Page témoin : `https://blok.tousamba.cloud/p/specs-sondage-quiz-c8ba4a96-7c07-4a32-8c39-3acda059c21c`
— 4 blocs.

## Contraintes du dépôt

- **TDD, non négociable** (`CLAUDE.md`) : écrire le test, le voir échouer, puis le code.
- `vitest` **ne vérifie pas les types** : une erreur de type passe les tests et casse
  le build Docker (`tsc --noEmit`).
- **`tsc` et ESLint épuisent le tas V8** sur le cœur dans ce worktree. **Ne pas
  augmenter les limites mémoire** (instruction utilisateur explicite) : le signaler.
- Un seul travail lourd à la fois : `python3 scripts/low-memory.py`.
- Un correctif de perf se prouve par une mesure avant/après avec le protocole
  ci-dessus, pas par une impression de fluidité.

## Points d'entrée

| Fichier | Rôle |
|---|---|
| `src/tools/database/database-card-drawer.ts:2587` | R17 — ce que cache le mode `full` |
| `src/tools/database/index.ts` ~9876 | `followRowPageHistory` — routage des lignes |
| `apps/service/page_urls.go` | résolution serveur ; `rowBodyOf` sans `databaseId` |
| `apps/service/mcp.go:61` | description de `blok_list_pages` annonçant `location` |
| `apps/service/page_locations.go:13` | « *Location is a read-only projection of the block tree* » |
| `src/components/modules/collaboration/` | outbox, lignée, quarantaine (voir aussi partie 3) |

---

# Partie 3 — En passant : « Enregistrement interrompu » qui ne se répare jamais

Constaté le même jour sur une autre page (`specs sondage & quiz`,
`64a9a1ec-8c97-4dda-…`). IndexedDB de ce document :

```
outbox      : 0
quarantine  : 4 opérations · reason "read-only" · 13:37:00 et 13:37:23 UTC
meta        : writeDenied: false
page créée  : 13:35:38 UTC
```

Quatre écritures faites **90 secondes après la création de la page** ont été
refusées en `read-only` — un document fraîchement créé l'est jusqu'à sa première
synchro (`index.ts:482` : « *unsynced, write-denied, or terminally disconnected
means "not editable"* » ; `index.ts:1073` : « *this boot goes on unadopted:
read-only until the first sync* »). La lignée est alors close définitivement
(`operation-store.ts:1049` : « *A quarantined lineage can take no further rows* »).

Trois défauts :

1. **Une fenêtre d'écriture perdue à la création** : l'éditeur accepte la frappe
   puis la jette, au lieu de refuser visiblement l'édition.
2. **Le bandeau ne se répare jamais** : `writeDenied` est repassé à `false` et
   l'outbox est vide, mais l'état d'erreur reste collé — rien ne purge la
   quarantaine, et il survit au rechargement.
3. **Le message est trompeur** : « vérifiez votre accès à l'espace » alors que
   l'accès est intact et qu'il s'agit d'une condition de course au démarrage.

## Une ligne en pleine page n'est pas dessinée comme une page (2026-11-20)

`/p/tenants-…` et `/p/123-pare-brise-…` sont deux pages pour qui les ouvre. La
seconde ne leur ressemble pas : couverture étroite au milieu de l'écran, icône
géante qui déborde sous elle, « Personnaliser la disposition » en évidence.

Ce n'est pas le gabarit de page : c'est le tiroir de la base, étiré.

- `desktop/src/row-page-navigation.css` masque, quand l'adresse désigne une
  ligne, la couverture du shell, les actions de la barre d'outils et les
  commentaires de page — sinon ils feraient doublon avec ceux du tiroir.
- `src/styles/database.css` (~2491) veut une couverture pleine largeur en mode
  `full`, mais le tiroir vit dans l'article, donc dans la colonne de contenu :
  `inset-inline: 0` s'arrête aux bords de cette colonne. Le commentaire du
  fichier le dit : « Nothing in a full page's column knows the page width ».

Deux issues :

1. Habiller le tiroir en pleine page comme une page — il faut alors le sortir
   de la colonne de contenu, ou donner à la couverture un ancrage qui connaît
   la largeur de la page.
2. Laisser le shell dessiner la page (couverture, icône, titre) et ne demander
   à la ligne que ses propriétés. C'est la cible, et la pièce qui manque est
   que le shell ne sait pas afficher les propriétés d'une ligne : il faudrait
   un canal par lequel la base les monte dans un hôte fourni par le shell,
   l'inverse du sens actuel.
