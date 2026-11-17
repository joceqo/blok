# Chargement des corps de lignes à la demande

Branche : `feat/lazy-row-bodies`.

Le document de la page conserve ses bases, lignes et propriétés. La migration
sort les descendants des lignes éligibles dans des documents ordinaires et pose
un `pageId` sur chaque ligne. Le navigateur ne crée leur éditeur et leur connexion
Yjs qu'à l'ouverture de la ligne. Les permissions héritent de la page source ;
les documents internes ne figurent pas dans la barre latérale.

La copie locale de la structure de Sprints indique 170 lignes éligibles, soit
601 blocs retirables sur 849 blocs stockés. Ce comptage n'est ni une migration de
production ni une mesure de durée. Le rapport du dry-run sur le journal réel
fait foi. Comparer ensuite plusieurs chargements avec le même navigateur et le
même nombre de pairs ; le délai de fin du profiler comprend son attente d'inactivité.

## Périmètre de cette première version

- Migration explicite, une fois par page. Les nouvelles lignes et les copies
  restent inline. Réexécuter `--apply` rend le résultat déjà effectué ; cela ne
  migre pas les nouvelles lignes.
- Les bases imbriquées, leurs lignes, les modèles, les lignes déjà liées et les
  anciens blobs non convertis restent intacts et sont signalés dans `skipped`.
- Le contenu des corps externes n'est pas utilisé pour les aperçus de cartes
  galerie/feed ni pour les opérations qui ne lisent que le document parent.
  Sprints utilise actuellement des tables et tableaux sans aperçu configuré.
- Dupliquer une page ou une ligne charge ses corps explicitement et les copie
  inline : les deux copies ne partagent pas un corps modifiable.
- Le corps utilise la collaboration, le cache hors ligne et l'outbox existants.
  Un corps jamais ouvert n'est pas disponible hors ligne. Historique et undo du
  corps sont ceux de son document ; les propriétés restent dans la page parent.
- Aucun changement des moteurs Yjs Go/C#/Rust : la migration appartient à l'hôte
  Go `apps/service` et réutilise ses documents et sa remise à zéro de lignée.

## Déploiement et migration manuelle

Fermer tous les anciens clients après synchronisation des dernières modifications,
comme convenu. Une ancienne application ne sait pas ouvrir ces corps séparés.
Ne pas rouvrir un ancien binaire après migration.

Sur le serveur, depuis le dépôt habituel, récupérer cette branche. Construire
**app et web**, démarrer la nouvelle app une fois pour installer le schéma, puis
faire une sauvegarde complète avec `deploy/backup.sh` (PostgreSQL ET `/data`).
Le script de sauvegarde redémarre l'app : l'arrêter à nouveau avant la migration.
Conserver les secrets `.env` séparément avec la sauvegarde.

Avec la configuration Compose du dépôt, depuis `deploy/` :

```sh
./stack.sh build app web
./stack.sh up -d --no-deps --wait app
./backup.sh
./stack.sh stop app web
./stack.sh run --rm --no-deps --entrypoint blokctl app rows migrate <id-interne-page>
```

Lire le rapport JSON du dry-run, puis appliquer :

```sh
./stack.sh run --rm --no-deps --entrypoint blokctl app rows migrate <id-interne-page> --apply
./stack.sh up -d --wait app web
```

Utiliser l'identifiant interne de la page, pas son slug public `/p/...`.


Si une interruption laisse une migration préparée, l'app refuse de démarrer :

```sh
./stack.sh run --rm --no-deps --entrypoint blokctl app rows migrate <id-interne-page> --resume
./stack.sh up -d --wait app web
```

Le verrou partagé de l'app et le verrou exclusif de maintenance empêchent leur
exécution simultanée avec cette version. Le dry-run lit le journal autoritaire et
le draine ; il ne crée pas de corps ni de marqueur de migration. L'application
est transactionnelle en SQL, puis change la lignée du document source. Les
projections de l'ancien journal sont interceptées pendant le reset pour ne pas
écraser le contenu préparé. La reprise revérifie le document avant de terminer.

`row_body_migrations` conserve le document initial et le plan. Ce n'est pas une
commande d'annulation : un retour arrière complet utilise la sauvegarde de la
base ET de `/data`, vers une installation vide via `deploy/restore.sh`.
Revenir au seul ancien commit après migration n'est pas un retour arrière des données.

## Validation

Tests ciblés avec `scripts/low-memory.py`, un seul à la fois ; tests Go avec
PostgreSQL jetable et conteneur limité en mémoire. 81 tests cœur et 28 tests desktop ciblés passent, ainsi que les tests Go ciblés
avec PostgreSQL et la compilation web. La validation couvre la
conservation du sous-arbre, les arbres invalides, le dry-run, la reprise, les
verrous, l'index, la duplication, le montage au clic, les permissions et la
fermeture des éditeurs. La compilation web vérifie aussi TypeScript.

Aucune migration ni aucun déploiement de production effectués par cette branche.
Après déploiement : ouvrir une ligne migrée, modifier son corps, fermer/recharger,
rouvrir, puis vérifier une ligne restée inline et la duplication. Mesurer Sprints
avant/après migration séparément de l'ouverture d'un corps.
