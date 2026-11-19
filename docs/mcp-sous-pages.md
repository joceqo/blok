# Un agent MCP ne peut pas créer de sous-page, un humain si

Écrit le 2026-11-19 sur `feat/row-page-navigation`. Diagnostic posé, correctif **non**
appliqué : il touche la configuration du service déployé, pas du code de test.

## Ce qu'on veut faire

Blok est un éditeur par blocs (type Notion). Loi d'architecture, dans `CLAUDE.md` :
**tout est un bloc**. Une base de données est un bloc, une ligne de base est un bloc
`database-row`, et le corps d'une ligne est constitué de ses blocs enfants — donc une
ligne *est* une page.

On documente des sprints. Structure voulue, sur `blok.tousamba.cloud` (workspace
`nexenture`) :

```
page « Sprints »
└── database « Sprints »
    └── database-row « Sprint #1 »        ← son corps est la page du sprint
        ├── database « Tâches »            (déjà en place, posée par MCP)
        └── page « Commits »               ← CE QU'ON N'ARRIVE PAS À CRÉER
            └── 189 commits en tableaux, 7 chantiers, ~250 blocs
```

Le détail des 189 commits doit vivre dans **sa propre sous-page**, pas étalé dans le
corps de la ligne : sinon la page du sprint fait 600 blocs et devient illisible — et
lente, voir « Pourquoi ça presse » plus bas.

## Le symptôme

**Dans l'éditeur, ça marche.** L'utilisateur tape `/page` dans le corps de la ligne,
le menu propose « Page », et la sous-page se crée. Capture à l'appui.

**Via MCP, les trois voies échouent :**

```js
// 1. insérer un bloc page dans la ligne
block.insert { type: 'page', parentId: '<rowId>', position: 'end', data: {} }
→ This host cannot insert "page": a new page needs its own document,
  and this host creates none.

// 2. même chose sans type
block.insert { name: 'page', ... }
→ block.insert: missing required field "type"

// 3. créer la page et la rattacher à la ligne
blok_create_page { workspace, title, parentId: '<rowId>' }
→ parent unavailable

// 4. déplacer une page existante sous la ligne
blok_move_page { pageId, parentId: '<rowId>' }
→ Destination not found
```

Les voies 3 et 4 sont **normales** : une page Blok se rattache à un document, jamais à
un bloc. Ce n'est pas le bug. La voie 1 est le vrai sujet.

## La cause, trouvée

Le message d'erreur dit lui-même où chercher
(`src/shared/agent/errors.ts:83`, `notPreparedHere`) :

> The editor's page tool creates one, so does blok-mcp with `--page-titles page-map`,
> and so does a C# host whose page target implements `IBlokPageCreator`.

Le chemin de décision, côté Node (`src/mcp/server.ts:65-67`) :

```ts
const pageMap = (options.pageTitles ?? DEFAULTS.pageTitles) === 'page-map';
const source = createSource(options.source);
const createsPages = pageMap && (options.sync !== undefined || source !== null);
```

et seulement si `createsPages` le port `createPageDocument` est exposé
(`src/mcp/server.ts:103-115`). Sans ce port, `insertUnavailableReason` renvoie `'host'`
et l'insertion est refusée.

Côté Go, strictement la même règle (`packages/server/go/blokmcp/pages.go:27`) :

```go
return s.options.PageTitles == "page-map" && (s.options.Sync != nil || s.source != nil)
```

**Et voici le point.** Le service déployé est le Go, monté dans
`apps/service/mcp.go:37-47` :

```go
attached, err := blokmcp.Embed(blokmcp.Options{
    Rooms:     rooms,
    Authorize: s.authorizeMCPDocument,
    OnTiming:  s.recordMCPTiming,
}, blokmcp.EmbedOptions{ /* Caller */ })
```

`PageTitles` n'est **pas** renseigné. Il vaut donc `""`, c'est-à-dire `"off"`
(`packages/server/go/blokmcp/options.go:19-20`), et `createsPages` est faux. D'où le
refus, alors que l'éditeur — qui a son propre `pageBackend` — n'a pas cette limite.

## Ce qu'il faut décider, puis livrer

1. **Est-ce voulu ?** Un agent qui crée des documents à volonté a des conséquences :
   quota, autorisation, facturation, pages orphelines. Si c'est une décision
   délibérée, elle n'est documentée nulle part, et le message d'erreur oriente vers
   un drapeau CLI (`--page-titles page-map`) qui n'a pas de sens pour un service
   hébergé. Au minimum, corriger le message côté hôte embarqué.

2. **Si ce n'est pas voulu :** passer `PageTitles: "page-map"` dans
   `apps/service/mcp.go`. Vérifier d'abord que la condition `Sync != nil || source != nil`
   est satisfaite dans ce montage — `Rooms` vient de `s.Blok.AgentExecutor()`, il faut
   confirmer que ça fournit bien une source au sens de `blokmcp`.

3. **`Options.CreatePage` existe** et mérite d'être regardé avant de livrer
   (`packages/server/go/blokmcp/README.md:134`) : par défaut Blok forge l'id, demande
   à `Authorize`, et enregistre un document vide. Le hook permet de créer ce document
   soi-même. Pour un service multi-workspace, c'est probablement là que doivent se
   brancher l'appartenance au workspace et les droits — pas dans le comportement par
   défaut.

4. **Parité obligatoire.** `CLAUDE.md` : toute fonctionnalité de `packages/server`
   existe en Go, C# **et** Rust, et la suite de conformité le prouve :
   `node scripts/test-server-conformance.mjs --target csharp|go|rust`.
   `test/unit/architecture/server-go-parity-law.test.ts` échoue si une cible sort de
   la CI.

## Pourquoi ça presse

Mesuré sur l'instance, traces serveur à l'appui (`blok_debug_traces`) : **chaque appel
MCP re-sérialise le document entier dans le runtime**. Sur un document de 627 blocs,
`blok_execute` met 3,1 s dont 2,84 s de `runtime_execute` — et seulement **7,6 ms** de
`apply_ops`, le travail réel. Le coût est en O(taille du document), pas en nombre de
commandes : 1 commande ou 40, même prix.

Ne pas pouvoir créer de sous-pages force donc à empiler tout le contenu dans un seul
document, ce qui dégrade *tous* les appels suivants sur ce document. Les sous-pages ne
sont pas un confort de mise en page : c'est le seul moyen qu'a un agent de garder des
documents de taille raisonnable.

## Contraintes du dépôt

- **TDD, non négociable** (`CLAUDE.md`) : écrire le test, le voir **échouer**, puis le
  code.
- `vitest` **ne vérifie pas les types**. Une erreur de type passe les tests et casse le
  build Docker (`tsc --noEmit`). Vu une fois dans cette session.
- **`tsc` et ESLint épuisent le tas V8** sur le cœur dans ce worktree. **Ne pas
  augmenter les limites mémoire** (instruction utilisateur explicite) : le signaler.
- Un seul travail lourd à la fois : `python3 scripts/low-memory.py`.
- Ne pas modifier `vite.config.mjs`, `vitest.config.ts`, `tsconfig.json`,
  `eslint.config.mjs`, `package.json` sans demande explicite.

## Points d'entrée

| Fichier | Rôle |
|---|---|
| `apps/service/mcp.go:37` | **le montage déployé** — `PageTitles` absent des options |
| `packages/server/go/blokmcp/pages.go:27` | la condition `createsPages`, côté Go |
| `packages/server/go/blokmcp/options.go:19` | `PageTitles` : `"off"` par défaut |
| `packages/server/go/blokmcp/README.md:134` | le hook `Options.CreatePage` |
| `src/mcp/server.ts:65` | la même condition, côté Node |
| `src/mcp/server.ts:103` | le port `createPageDocument` exposé sous condition |
| `src/mcp/opener.ts:114` | suivi des pages créées (`madePages`) |
| `src/shared/agent/errors.ts:79` | `insertUnavailableReason` — `'host'` vs `'runtime'` |
| `src/shared/tool-descriptions/page.ts:33` | `requires: ['pageBackend']` |
| `src/shared/agent/document-session.ts:155` | `createPageMapBackend`, le backend réel |

## Reproduire

Document de test : la page « Sprints (refonte) »,
`https://blok.tousamba.cloud/p/sprints-refonte-32e6106d-774f-4290-9102-3e9fbea11a71`.
La ligne `5958BKGKep` (Sprint #1) de la base `fpe5rzCf72` contient déjà une base de
tâches dans son corps — un `block.insert` de type `page` avec `parentId` valant cet id
de ligne doit réussir, et la sous-page doit s'ouvrir depuis le corps de la ligne.

Attention en testant : `blok_read` plafonne à **200 blocs** et rend un curseur `next`.
Un client qui l'ignore croit le document plus petit qu'il n'est — c'est ce qui a fait
passer un export de 188 lignes pour 182 dans cette session.
