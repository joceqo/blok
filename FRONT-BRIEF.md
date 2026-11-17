# Gel au chargement d'un éditeur de blocs — reprise du diagnostic

> Brief autonome. Tous les chiffres sont **mesurés** en production (Chrome,
> profil CPU échantillonné via la JS Self-Profiling API), jamais estimés.

## Le produit

Blok : éditeur de blocs headless type Notion, « everything is a block »
(`parentId` / `contentIds`). Document partagé en CRDT **Yjs**, cache local
IndexedDB, collaboration temps réel.

Page de test : **870 blocs** — 24 à la racine, 189 à profondeur 1, 657 à
profondeur 2. Les 24 racines portent les 846 autres, et **une seule** commence
dans le premier écran. Plusieurs racines sont des bases de données de ~2035 px.

## État actuel

| | Au départ | Aujourd'hui |
|---|---|---|
| Gel total | 49 s | **9,0 s** |
| Plus longue tâche | ~35 s | **~1,5 s** |

Écarté par la mesure, à ne pas réexplorer : le réseau (aucune requête > 300 ms,
bundle 139 Ko gzip), le poids du document Yjs (869 Ko, 50 000 opérations
chargées en ~40 ms — Yjs n'apparaît nulle part dans le profil), et le rendu en
soi (en navigation interne, les mêmes blocs s'affichent en 307 ms).

## Profil actuel (9,0 s)

```
rerenderView        1460 ms (16 %)   reconstruction d'une vue database liée
get offsetWidth      792 ms (9 %)    reflow forcé
getBoundingClientRect 374 ms (4 %)
refold               248 ms (3 %)
getAnchorNode        144 ms (2 %)
```

Plus aucune pathologie dominante : le reste est une longue traîne. C'est le
coût de monter 870 blocs.

## Ce qui a fonctionné (déployé)

1. **Layout thrashing sur la sélection** (49 → 20,5 s). `selectionInside` lisait
   `getSelection().anchorNode` juste après chaque écriture DOM, en boucle :
   862 lectures à ~31 ms. Remède : lire **une fois par lot** et répondre par
   `node.contains(ancre)` (0,002 ms).
2. **Même faute dans l'observer de l'outil Bold** (20,5 → 10,5 s) : ne lire la
   sélection que si le lot contient un `<b>` hérité.
3. **Découpage de l'activation** en tranches de 8 ms avec `scheduler.yield()` :
   la plus longue tâche passe de ~2 s à ~1,5 s.
4. **Reconstructions d'une vue liée** : 44 → 24, en attendant la fin du montage
   au lieu de redessiner chaque état intermédiaire.

Le motif commun des deux premières : **une lecture dépendante du layout juste
après une écriture DOM, en boucle**.

## Les trois échecs, avec leur cause

À ne surtout pas refaire :

1. **Découper aussi la création des blocs (passe 1)** → **deux fois pire**
   (9,5 → 15,0 s) et rendu cassé. La passe 1 porte un raccourci valide
   uniquement tant que le remplissage est séquentiel et ininterrompu
   (`initialBatch && repository.length === created.length`). Rendre la main
   laisse d'autres lots s'intercaler, l'égalité devient fausse, et chaque bloc
   retombe sur un chemin quadratique. *Leçon : un découpage n'est sûr que si
   l'invariant tient à CHAQUE frontière de tranche.*
2. **Replier la rafale de reconstructions sur une frame** → **25 → 47
   reconstructions**. Les rendus sont étalés sur des secondes, pas tassés dans
   une frame : chacun ouvrait sa propre fenêtre. Et différer d'une frame a
   introduit un bug visible (le bandeau « source supprimée » restait affiché
   après un undo qui ramenait la source).
3. **Éliminer les reconstructions dont la source relit identique** →
   **n'élimine RIEN**, et coûte 34 lectures complètes (9,0 → 10,0 s). La source
   se **remplit** pendant qu'elle rend : les 34 lectures différaient réellement.
   C'étaient 34 états sur le chemin d'un seul résultat.

## Le problème ouvert

Objectif : ne plus monter 870 blocs quand un seul écran est visible.

L'infrastructure de rendu différé **existe déjà** et fonctionne (elle sert
aujourd'hui aux corps de lignes de database fermées) :

- `deferRender` / `shouldDeferRender` (`src/components/modules/blockManager/factory.ts`)
  — le DOM de l'outil n'est jamais construit ;
- placeholder + attribut `data-blok-deferred-render` (`src/components/block/tool-renderer.ts`) ;
- réveil par `DEFERRED_RENDER_EVENT` sur le holder → `renderIfVisible()`, qui
  re-interroge `shouldDeferRender` (`src/components/block/index.ts:437,649`) ;
- dormance des données : `extractToolData` renvoie `lastSavedData`, donc
  `save()`, l'undo et le replay distant traversent un sous-arbre jamais rendu
  **sans perte**.

Son unique prédicat est `isClosedRowBody` — « je suis dans le corps d'une ligne
de database fermée ». **Il n'existe aucune notion d'écran.**

### La tentative en cours, qui ne s'active pas

Ajouté : `src/components/utils/viewport-render.ts` — une passe de chargement qui
laisse les `EAGER_ROOTS = 3` premières racines se dessiner et endort les
suivantes, un `IntersectionObserver` (marge 1200 px) qui les réveille à
l'approche, et `data-blok-offscreen { min-height: 320px }` pour qu'un document
entier de dormeurs ne s'écrase pas sur un écran (sans quoi tous se déclarent
visibles et se réveillent ensemble).

Câblage : `beginViewportPass(EAGER_ROOTS)` au début de la passe 1 de
`handleYjsBatchAdd` (`src/components/modules/blockManager/yjs-sync.ts`), gardé
par `initialBatch` ; `endViewportPass()` après la boucle de composition ;
prédicat dans `composeBlock` (`factory.ts`) :

```ts
const viewportSleep = deferRender === undefined
  && this.sleepsForViewport(name, parentId, origin);
// racine → !claimEagerRoot() ; enfant → hasSleepingAncestor(parentId)
```

**Mesuré après déploiement : 870 blocs montés, 0 avec `data-blok-offscreen`,
9003 ms — strictement inchangé.** Le code est bien dans le bundle livré (la
chaîne `data-blok-offscreen` y est présente). Donc `viewportSleep` est toujours
faux, et on ne sait pas encore lequel des maillons casse.

Des compteurs viennent d'être déployés (`__blokViewportProbe` : `passes`,
`asked`, `outsidePass`, `eager`, `slept`, `withParent`) et sont affichés par le
profil sous `Rendu au viewport :`. **Les lire est la toute première chose à
faire** — ils éliminent d'un coup les hypothèses restantes (passe jamais
ouverte ? budget jamais interrogé ? tous les blocs arrivent avec un parent ?).

## Questions

1. Pourquoi le prédicat ne s'active-t-il pas ? (les compteurs devraient le dire)
2. `EAGER_ROOTS = 3` est-il le bon découpage, sachant qu'une racine fait
   ~2035 px et qu'une seule tient dans le premier écran ?
3. Les 320 px réservés sont une estimation grossière (réalité ~2035 px). La
   barre de défilement bougera pendant le remplissage. Acceptable, ou faut-il
   estimer la hauteur à partir du nombre de descendants ?
4. `rerenderView` pèse encore 1460 ms. Une vue database liée se reconstruit
   entièrement ; AG Grid distingue `refreshCells()` (détection de changement
   par cellule) de `redrawRows()` (reconstruction). Ici tout est `redrawRows`.
   Vaut-il mieux attaquer ça, ou le viewport d'abord ?

## Contraintes

- **Pas de virtualisation destructive** : démonter les blocs hors écran casse la
  sélection et la recherche native dans un `contenteditable`.
- La collaboration doit continuer : un pair ne doit jamais observer un état à
  moitié appliqué.
- **jsdom n'a ni moteur de layout ni tâches réelles : aucun test unitaire ne
  peut prouver ces gains.** La validation passe par le navigateur (profil
  `?profile=1`) ou Playwright.
- Les Web Workers sont hors jeu : le travail est du DOM.
- Tests d'abord (le projet l'impose) : écrire le test, le voir échouer, puis
  corriger.
- `eslint` et `tsc` épuisent la mémoire sur `src/tools/database/index.ts`
  (13 000 lignes) sur la machine de développement ; le typage des derniers
  changements n'est pas prouvé.

## Références utiles

- [What forces layout/reflow (Paul Irish)](https://gist.github.com/paulirish/5d52fb081b3570c81e3a)
- [Forced reflow — Chrome for Developers](https://developer.chrome.com/docs/performance/insights/forced-reflow)
- [scheduler.yield — WICG](https://github.com/WICG/scheduling-apis/blob/main/explainers/yield-and-continuation.md)
- [AG Grid — change detection](https://www.ag-grid.com/javascript-data-grid/change-detection/)
- [Virtual scrolling vs contenteditable](https://contenteditable.realerror.com/scenarios/scenario-virtual-scrolling/)
