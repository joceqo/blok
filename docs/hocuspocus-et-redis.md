# Hocuspocus et Redis : deux options, et leur prix

Note de conception, non décidée. Elle répond à deux questions posées le 27 novembre 2026 :
« pourrait-on utiliser Hocuspocus dans notre backend Hono ? » et « en quoi un Redis
nous aiderait ? »

Elle complète `backend-node-vs-affine-docmost.md`, qui est un audit. Celle-ci est un
inventaire d'options : rien n'y est recommandé, tout y est chiffré.

Relevés sur `docmost/docmost` à `ba501b50` et `toeverything/AFFiNE` à `b85148565`.

---

## 1. Pourquoi la question se pose

Notre protocole est un **sur-ensemble** du protocole y-websocket standard
(`src/components/modules/collaboration/sync-wire.ts`) :

| Type | Nom | Origine |
|---|---|---|
| 0 | `sync` | y-protocols |
| 1 | `awareness` | y-protocols |
| 2 | `auth` | y-protocols |
| 3 | `queryAwareness` | y-protocols |
| 100 | `control` | Blok |
| 101 | `limits` | Blok |
| 102 | `operation` | Blok |
| 103 | `acknowledgement` | Blok |
| 104 | `rejection` | Blok |
| 106 | `activity` | Blok |
| 107 | `identities` | Blok |

Hocuspocus parle 0 à 3. En `blok-sync.v1`, notre client est proche du Yjs nu. La question
« peut-on brancher Hocuspocus » est donc légitime, pas théorique.

## 2. Pourquoi ça ne marche pas tel quel

`provider.ts:1536` ouvre toute connexion dans la phase **`awaiting-control`** : le client
envoie son `SyncStep1`, **met en tampon toutes les trames entrantes**, et ne raccorde
l'éditeur qu'une fois la trame `control` reçue.

La raison est écrite en tête du fichier :

> Un document dont la lignée ne correspond plus à la salle ne doit jamais faire fuiter
> son historique dans une salle qui a été remise à zéro.

Hocuspocus n'émet jamais de `control`. Le client resterait bloqué, tampon qui se remplit,
éditeur jamais raccordé. **Ce n'est pas une incompatibilité de détail : c'est la première
trame attendue.**

## 3. Ce que coûterait une extension Hocuspocus

Il faudrait écrire une extension qui émet nos trames 100-107 :

| Trame | Ce qu'il faudrait |
|---|---|
| `control` | une notion de lignée/époque → **donc un stockage qui la porte** |
| `limits` | trivial, une constante de configuration |
| `identities` | réécrire l'awareness côté serveur (la recette de Docmost, voir §5) |
| `operation` / `acknowledgement` | rendre un numéro de séquence → **donc un journal** |
| `rejection` | les codes de refus |
| `activity` | non implémenté côté Node aujourd'hui (voir audit §3.9 pour la même famille d'écart) |

Les deux lignes en gras portent toute la difficulté. **Il faudrait réimplémenter le
sidecar à l'intérieur de Hocuspocus**, ce qui annule le gain.

## 4. La vraie question n'est pas Hocuspocus

Elle est : **abandonne-t-on le sidecar séparé ?**

En répondant oui, l'architecture de Docmost devient cohérente de bout en bout :

- collaboration dans le Hono, même processus ;
- connexion directe en processus pour les agents MCP (`hocuspocus.openDirectConnection`) ;
- awareness réécrite côté serveur ;
- **plus aucune extension 100-107** ;
- échelonnement Redis par-dessus.

Le prix, lui aussi entier : plus d'hôtes Go, C# et Rust, plus de contrat de conformance,
et l'historique redevient un module séparé au lieu de tomber du format du journal.

C'est un arbitrage de produit, pas de technique.

### Le détail qui rend leur modèle cohérent

`apps/server/src/collaboration/collaboration.handler.ts` :

```ts
const connection = await hocuspocus.openDirectConnection(documentName, context);
await connection.transact(fn);
```

Une connexion **en processus** au même document. Pas de réseau, donc pas besoin d'accusé
de réception. Ils ont même traité le détail qui fâche : `flushPendingStore` force la
sauvegarde avant, pour que les éditions en attente ne soient pas attribuées à l'agent.

**Nos trames `operation`/`acknowledgement` ne sont pas rendues nécessaires par le fait
d'avoir des agents. Elles le sont par le choix du sidecar séparé.** La frontière est un
vrai réseau, et un réseau exige qu'on sache si l'écriture a abouti.

## 5. Les quatre extensions de Docmost

Trois sont montées dans la configuration Hocuspocus, la quatrième est construite à part
et seulement si Redis est configuré (`collaboration.gateway.ts`).

### `AuthenticationExtension`
`onConfigure`, `onDestroy`, `onAuthenticate`.

Décode le JWT, charge l'utilisateur et la page, vérifie l'appartenance à l'espace de
travail, calcule l'accès. Trois issues : refus, `connectionConfig.readOnly = true`
(c'est Hocuspocus qui fait respecter la lecture seule), ou `{ user }` qui devient le
contexte de connexion. Porte aussi `recheckAccess`, qui rejuge les connexions **déjà
ouvertes** quand les droits changent — l'équivalent de notre `revalidate`.

### `PersistenceExtension`
`onLoadDocument`, `afterLoadDocument`, `onStoreDocument`, `beforeHandleAwareness`,
`onChange`, `afterUnloadDocument`.

`onLoadDocument` lit `page.ydoc` ; s'il est vide, convertit le JSON Tiptap en document Yjs
(leur chemin de migration). `onStoreDocument` écrit l'état complet dans la colonne `bytea`,
en débordement temporisé. `onChange` alimente l'historique de page.

`beforeHandleAwareness` mérite d'être cité, parce qu'il règle à moindres frais ce que notre
trame `identities` règle à grands frais :

```ts
if (state.user && user) {
  state.user.id = user.id;
  state.user.avatarUrl = user.avatarUrl ?? null;
}
```

Le client déclare son identité dans l'awareness, **et le serveur la remplace par celle de
la connexion authentifiée** avant diffusion. Même garantie que `identities`, sans nouveau
type de message.

### `LoggerExtension`
`afterUnloadDocument`, `onDisconnect`. Trace uniquement.

### `RedisSyncExtension`
`onSocketOpen`, `onSocketMessage`, `onSocketClose`, `onConfigure`, `onLoadDocument`,
`afterUnloadDocument`, `onDestroy`.

C'est la pièce maîtresse. Elle intercepte **au niveau de la socket brute**, pas du
document. `CollabProxySocket` tient lieu de socket client sur le serveur qui possède le
document ; le trafic transite par Redis depuis le serveur d'origine.

## 6. Ce qu'un Redis nous apporterait

**Il achète le routage, pas le stockage.** C'est la distinction qui décide.

### Les gains

1. **La limite « un document, un hôte » disparaît côté client.** Aujourd'hui l'hôte A
   tient le verrou, l'hôte B répond 503. Avec un relais, B accepte la socket et fait
   transiter les trames vers A. Le propriétaire reste unique mais devient invisible de
   l'extérieur.
2. **Un registre explicite du propriétaire.** Aujourd'hui un hôte découvre que le verrou
   est pris en **échouant** à le prendre. Avec Redis on le sait avant d'essayer, et on
   route au lieu de refuser.
3. **La présence entre nœuds.** Deux clients du même document sur deux hôtes ne se voient
   pas aujourd'hui. Avec le relais ils sont dans la même salle : le problème disparaît
   au lieu d'être résolu.

### Les réserves

1. **Le stockage reste partagé.** Notre verrou est un `flock` sur un répertoire, et le
   test de conformance lance deux hôtes sur le **même** `--collab-dir`. Redis ne change
   rien : le propriétaire doit toujours atteindre le journal.
2. **Redis ne doit pas remplacer le verrou.** Un `flock` est libéré par le système
   d'exploitation à la mort du processus. Un bail Redis avec expiration ne donne pas
   cette garantie — c'est le débat Redlock. **Sur la durabilité, notre verrou actuel est
   plus fort.** Redis router, `flock` arbitrer.
3. **Ce serait notre première dépendance d'infrastructure.** On en a zéro. Et elle
   s'écrirait quatre fois, ou deviendrait une capacité optionnelle — ce qui demande de
   trancher si la conformance l'exige ou la tolère.

### Où ça se brancherait chez nous

Le point d'interception de Docmost (`onSocketOpen` / `onSocketMessage` / `onSocketClose`)
correspond au chemin d'admission de `packages/server/node/src/host/sync-room.ts`. C'est là
que vit aujourd'hui le refus 503, et c'est là que le relais remplacerait le refus.

Aucune autre couche n'est concernée : ni le journal, ni la salle, ni les portes HTTP.

## 7. À vérifier avant toute décision

- `activity` (type 106) n'est pas traitée par le sidecar Node : son décodeur ignore les
  types inconnus. Go l'implémente (`internal/collab/room/activity.go`), le C# aussi.
  Aucun test de conformance ne l'exerce — d'où 528/528 malgré l'écart.
- `limits` (type 101) pourrait être une constante ou un en-tête de poignée de main. Elle
  ne mérite un type de message que parce que le plafond est configurable par hôte. C'est
  défendable, ce n'est pas évident.
