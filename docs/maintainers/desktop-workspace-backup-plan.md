# Sauvegarde portable d’un espace Blok Desktop

Proposition pour le DMG avec backend Node. Au premier lancement, la personne dispose déjà d’un espace sur son Mac. Depuis le sélecteur, **Ajouter un espace** crée ou ouvre un autre espace. **Sauvegarder cet espace** copie l’espace actif vers une destination choisie. **Restaurer une sauvegarde** ouvre la copie dans un nouvel espace. Le dépôt ou le disque appartient à la personne. Ces trois parcours peuvent fonctionner sans infrastructure hébergée par Blok.

## Point de départ sur la branche d’intégration

Le desktop utilise Tauri et démarre Node, PostgreSQL, le service de collaboration et SeaweedFS sur la boucle locale. Les anciens espaces disque ont aussi leur propre format. Une autre entrée du service Node possède un export de métadonnées (pages, membres et presets). Le DMG lance le serveur shell et embarque le schéma de `apps/service`. Sa sauvegarde doit partir de ces sources effectives. Le script de sauvegarde du déploiement Docker couvre, lui, une instance entière. [Desktop](../../desktop/README.md) · [Services embarqués](../../desktop/runtime/supervisor.ts) · [Manifeste actuel](../../apps/service-node/src/workspaces/export-manifest.ts) · [Sauvegarde d’instance](../../deploy/backup.sh)

Proposition pour la première version : conserver les écritures de l’éditeur dans les services locaux existants. Node produit une représentation portable à la demande. Ce choix permet de tester la restauration sur un autre Mac avant d’envisager un dossier directement éditable par d’autres outils. Le périmètre initial est l’espace personnel du runtime Node embarqué. Le sélecteur distingue explicitement les espaces historiques sur disque et les instances distantes.

## Une sauvegarde complète et vérifiable

1. **Délimiter l’espace.** Partir de son identifiant et contrôler les droits côté service, comme pour la route d’export existante. Inventorier les données persistantes par fonctionnalité : arborescence et corbeille, documents, lignes de bases et leurs corps, relations, vues, presets, médias, autres données propres à l’espace. Documenter les éléments à reconnecter après restauration, comme un compte calendrier. Exclure sessions, invitations actives, jetons, clés de l’instance et données des autres espaces. Restaurer sous le propriétaire local courant.
2. **Capturer une version cohérente.** Vider la file des écritures de l’éditeur, attendre la persistance des mises à jour de la room, puis figer le périmètre de lecture pour cet espace. Associer chaque document à sa révision ou à son checkpoint durable, avec les mises à jour nécessaires à sa relecture. Épingler les médias référencés pendant la capture. Relâcher la coordination locale avant tout transfert réseau. Si un état cohérent ne peut être obtenu, conserver la dernière sauvegarde complète.
3. **Écrire dans un dossier temporaire.** Un manifeste versionné identifie l’espace, l’instantané, sa version de format et chaque fichier avec sa taille et son SHA-256. Les documents utilisent des identifiants stables. La table des médias associe la clé logique Blok, le nom, le type et l’empreinte aux octets originaux. Deux références au même média peuvent partager ces octets. Traduire les URL signées ou liées au port du Mac en références portables et les résoudre à l’import. Les liens web saisis volontairement restent des liens externes.
4. **Restaurer dans un espace en préparation.** Valider la version, les chemins, l’inventaire et les empreintes, puis importer les médias dans le stockage du nouveau runtime. Réassocier les documents et les relations aux identifiants de destination, notamment si la source existe déjà sur ce Mac. Publier l’espace dans le sélecteur après vérification des références. Une interruption reprend ou abandonne uniquement cette restauration en préparation.

## Choisir le transport selon la destination et les fichiers

La personne choisit où vont ses données. L’app adapte le mode de transfert à l’intérieur de cette destination. Avant l’envoi, elle calcule le plus gros fichier, les octets nouveaux à transférer et les capacités connues du dépôt ou du volume. Un quota inconnu reste indiqué comme tel. Un dépassement présente le fichier concerné et les destinations possibles. Tout changement de destination est explicite.

| Destination proposée | Quand la proposer | Publication d’une sauvegarde complète |
| --- | --- | --- |
| Dossier, disque externe ou NAS monté | Première version, hors ligne possible. Bon choix pour plusieurs Go de vidéos. Indiquer si la copie est sur le même disque que l’original. | Copier les fichiers dans une génération temporaire sur le volume cible. Vérifier tailles et empreintes, puis publier un manifeste de fin. Une déconnexion laisse la génération précédente disponible. |
| Dépôt Git privé, par exemple GitHub ou GitLab | Pour les documents et les petits médias. Si un média dépasse le seuil choisi pour l’hôte, utiliser Git LFS si le dépôt le prend en charge. | Utiliser un dépôt de sauvegarde dédié à l’espace. Configurer les règles LFS et versionner `.gitattributes` **avant le premier commit qui contient les médias concernés**. Envoyer les objets LFS puis la référence Git. Conserver les commits en attente après une panne. |
| Bucket S3 compatible, par exemple Cloudflare R2 ou Backblaze B2 | Pour les bibliothèques vidéo importantes ou une personne ayant déjà un bucket. L’app Node dialogue directement avec le fournisseur. | Transférer les objets sous leur empreinte, par envoi multipart reprenable si disponible. Publier le manifeste de l’instantané en dernier. La restauration reconstitue le fichier original. |

Un MP4 de 600 Mo illustre la décision. Sur disque, l’app copie l’original. Avec GitHub, l’app propose LFS avant de créer le commit. Avec un bucket compatible, elle peut envoyer le même MP4 par parties sans changer le fichier que récupère le lecteur. La qualité originale est conservée. Un refus du serveur, un quota dépassé ou un pointeur LFS sans contenu maintient la sauvegarde ou la restauration à l’état incomplet. Les limites dépendent du fournisseur et de l’offre. [GitHub et fichiers volumineux](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) · [Git LFS sur GitLab](https://docs.gitlab.com/topics/git/lfs/) · [Compatibilité S3 de R2](https://developers.cloudflare.com/r2/api/s3/api/) · [API S3 de B2](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)

**Prérequis pour la vidéo.** Le service média Node a une limite d’import par défaut de 32 MiB et le superviseur desktop lance ce service sans surcharge de taille. Valider d’abord l’import local depuis le DMG. Prévoir une lecture en flux avec limites d’espace disque et de taille, en conservant une limite indépendante pour les téléchargements depuis une URL. Activer LFS seul ne permettrait pas d’importer le MP4 de l’exemple. [Limite d’import](../../packages/server/node/src/host/upload.ts) · [Validation des limites](../../packages/server/node/src/args/validate-startup.ts) · [Lancement du média](../../desktop/runtime/supervisor.ts)

## Contrat technique proposé pour le DMG

### Capture d’un espace personnel

Le point d’intégration Node est le serveur shell embarqué. Tauri présente le sélecteur natif de dossiers et remet au coordinateur local une destination approuvée. L’interface transmet un identifiant de destination opaque. Le serveur résout cet identifiant dans le profil de l’appareil. Le sélecteur actuel représente déjà l’instance embarquée par une référence avec les attributs `device` et `embedded`. L’autorisation doit être contrôlée dans le runtime avec la session de l’appareil. [Assemblage du DMG](../../desktop/scripts/bundle-runtime-services.mjs) · [Serveur shell](../../apps/service-node/src/shell/app.ts) · [Sélecteur](../../desktop/src/workspace-registry.ts)

| Source du DMG | Données à capturer | Règle de restitution |
| --- | --- | --- |
| PostgreSQL, schéma embarqué | Espace, pages et métadonnées, ordre, hiérarchie, corbeille, rattachements aux teamspaces, emojis et événements créés dans l’espace. Inclure les pages de ligne même en dehors de la navigation principale. | Remapper les identifiants de pages, teamspaces et événements dans le nouvel espace. Conserver les identifiants internes aux blocs lorsque leur portée est le document. |
| Room Node et projection `pages.content` | État éditable courant, dont documents de lignes, tableaux, vues et commentaires intégrés. Identifier la tête durable par document, avec lignée et séquence lorsqu’elles existent. | Repartir d’un état éditable avec une nouvelle lignée. La V1 restaure l’état au moment de la capture. L’écran de sauvegarde indique que l’historique d’édition antérieur et les connexions externes sont hors périmètre. |
| Service média et SeaweedFS | Originaux utilisés par l’espace, y compris couvertures, icônes et emojis. Vérifier le rattachement à l’espace côté serveur. Inventorier les références externes séparément. | Dédupliquer les octets par empreinte, recréer les associations par document et résoudre les références à partir des nouvelles clés médias. |
| Droits et intégrations | V1 limitée à l’espace personnel du compte appareil. Vérifier l’absence d’autres membres et de partages qui rendraient la copie personnelle ambiguë. Revalider ce périmètre lors de la capture. | Le compte local devient propriétaire. Demander de reconnecter les services externes. Exclure sessions, jetons, URL de calendrier privées, secrets média, adresses signées et notifications de l’instance source. |

Le schéma livré porte `content`, `version`, `lineage` et `sequence` sur la page. Une projection peut être en retard sur une écriture acceptée par la room. Une lecture PostgreSQL seule peut donc produire une sauvegarde valide au niveau des empreintes mais incomplète pour l’utilisateur. [Schéma livré](../../apps/service/schema.sql) · [Persistance des projections](../../apps/service-node/src/shell/projection.ts) · [Test du délai de projection](../../packages/server/node/src/collab/room/document-room-export.fast.test.ts)

**Barrière de capture proposée.** Le coordinateur attend les écritures admises depuis tous les clients locaux de l’espace, réserve une courte fenêtre pendant laquelle les nouvelles mutations de cet espace sont mises en attente, puis demande aux rooms leur tête durable et le vidage des projections. Les écritures de projection internes doivent rester admises pendant cette fenêtre. Une fois les têtes confirmées, ouvrir une transaction PostgreSQL `REPEATABLE READ`, établir son instantané par une première lecture, vérifier les versions et épingler les clés médias immuables contre la purge. Relâcher ensuite la barrière. Copier les données SQL de cet instantané dans le staging local, terminer la transaction et transférer les médias par flux. Une pièce jointe absente ou une projection en retard à l’expiration du délai fait échouer la capture avec l’identifiant concerné. Un arrêt libère la barrière et les épingles périmées sont récupérables. L’envoi vers le disque externe ou le réseau a lieu après cette capture.

### Format portable v1

Un instantané est immuable. Le manifeste contient `format = "blok-workspace"`, `version = 1`, `snapshotId`, `sourceWorkspaceId`, `capturedAt` en UTC et un tableau `files`. Chaque entrée contient un chemin relatif UTF-8 normalisé, un rôle, une taille entière en octets et une empreinte SHA-256 hexadécimale. Le marqueur final contient l’identifiant de l’instantané et le SHA-256 des octets exacts du manifeste. Une version majeure inconnue arrête l’import avant toute mutation.

```text
snapshots/<snapshotId>/
  manifest.json
  workspace.json              nom, teamspaces, événements, emojis
  pages/<pageId>.json          métadonnées, corbeille, tête capturée, corps éditable
  assets.json                 clé logique, associations, type, nom, taille, empreinte
  complete.json               publié en dernier
objects/sha256/<empreinte>     octets originaux, réutilisables entre instantanés
```

Les chemins de `files` sont relatifs à la racine de la sauvegarde. Ils couvrent les fichiers de données de la génération et tous ses objets référencés. Rejeter doublons, chemins absolus, liens symboliques, traversées de dossiers et collisions de casse sur la cible. Dériver les noms de fichiers d’identifiants validés. Le nom d’origine d’une pièce jointe reste une métadonnée. Une page sans corps persisté porte explicitement `body: null`. Si un type de bloc ou une relation ne peut être restauré fidèlement, arrêter avant publication et nommer l’élément concerné.

### Opérations, concurrence et reprise

| Opération locale proposée | Résultat observable |
| --- | --- |
| `prepare(workspaceId, destinationId)` | Inventaire, volume nouveau estimé, capacités connues, éléments à reconnecter et éventuels blocages. Un volume ou un quota inconnu reste explicite. |
| `startBackup(requestId, workspaceId, destinationId)` | Renvoie un identifiant de tâche durable. Une répétition du même appel retrouve la même tâche. Chaque couple espace/destination a un seul écrivain. |
| `getJob(jobId)` et `retry(jobId)` | Phases « Capture », « Transfert », « Vérification », puis « Sauvegardé », avec octets confirmés et erreur exploitable. Reprendre un transfert avec le même instantané même après redémarrage. Une capture inachevée repart d’une nouvelle capture. |
| `inspectSnapshot(destinationId, snapshotId)` puis `restore(requestId, snapshotId, destinationId)` | Présenter nom, date, nombre de pages et volume. Créer une copie privée sur cet appareil. Un double clic ou une reprise retrouve la même tentative de restauration. |

Le journal local conserve la phase, les identifiants de génération et de destination, les objets confirmés et, selon le transport, le commit ou l’identifiant multipart. Chaque enregistrement critique précède son accusé de réception. En cas de réponse réseau perdue après publication, sonder la destination pour le même identifiant et la même empreinte avant de réessayer. Le choix d’un autre espace dans l’interface n’altère jamais l’espace associé à la tâche.

**Décision de transport.** Sur Git, le seuil de passage à LFS est une préférence du dépôt plafonnée par la limite de l’hôte. Pour un hôte inconnu, une capacité non vérifiée demande confirmation ou un essai de prévol avant l’envoi. Utiliser une règle LFS par chemin d’objet si nécessaire : les objets adressés par empreinte n’ont pas d’extension vidéo. Écrire cette règle avant d’indexer le fichier. Sur un bucket, les empreintes correspondent aux octets d’origine ; la vérification reste indépendante de l’ETag multipart. Sur disque amovible, associer la destination à un identifiant stocké sur le volume pour détecter un autre disque monté au même chemin. Pour chaque transport, la dernière sauvegarde réussie est celle publiée **et vérifiée à destination**, y compris ses objets LFS.

**Restauration en deux phases.** Vérifier le marqueur, le manifeste et l’espace disponible avant l’import. Pendant la copie des objets, vérifier leur taille et leur empreinte. Construire une table de correspondance durable entre anciens et nouveaux identifiants avant d’importer les documents. Réécrire uniquement les champs typés de référence (pages, relations de lignes, médias, liens de calendrier), en préservant le texte libre et les URL externes. Préparer les médias et les corps sous des clés propres à la tentative. Publier les lignes de l’espace et son adhésion au compte local dans une transaction finale, sans rejouer les notifications ni envoyer d’invitations. Après le commit, rafraîchir le sélecteur depuis le service. Si l’app s’arrête à cet instant, le journal permet de retrouver l’espace publié avant toute nouvelle création.

### Vérifications qui conditionnent la livraison

| Situation à reproduire | Observation attendue |
| --- | --- |
| L’utilisateur saisit une phrase et lance la sauvegarde pendant que la projection SQL attend. | La phrase acceptée est présente après restauration ou la capture signale son échec. |
| Une ligne possède un corps, un lien interne et une image partagée avec une autre page. | Les deux documents restent éditables, le lien ouvre la ligne restaurée et un seul objet média est stocké dans l’instantané. |
| Le disque est retiré après l’écriture des objets et avant le marqueur final. | La génération précédente est restaurable. La nouvelle génération reprend après reconnexion du bon volume. |
| Le push Git réussit mais sa réponse se perd, ou un objet LFS manque au téléchargement. | La reprise reconnaît le commit déjà publié. Un objet absent bloque la publication de l’espace restauré et peut être retéléchargé. |
| Deux restaurations sont lancées sur le Mac source, dont la première est interrompue. | Une répétition avec le même identifiant reprend la première. Une demande distincte crée une copie distincte. Les relations des copies pointent vers leurs propres pages. |
| Une clé média d’un autre espace, un jeton expiré ou un chemin sortant de la sauvegarde est injecté dans la fixture. | Aucun octet de l’autre espace et aucun secret ne sortent. Le chemin invalide est refusé avant toute écriture hors staging. |

## Livraison et critères d’acceptation

1. **Disque externe et restauration.** Construire l’export/import logique côté Node et les trois entrées du sélecteur. Sur deux installations vierges du DMG, restaurer une fixture comprenant une page imbriquée, une page en corbeille, une ligne avec corps et une pièce jointe. Vérifier les relations, les contenus éditables, la lecture hors ligne et les empreintes. Placer un média témoin dans un second espace et vérifier son absence dans la sauvegarde. Simuler un retrait du disque pendant la copie.
2. **Git et Git LFS.** Embarquer les exécutables et les transports requis dans le DMG signé et les tester sur un Mac sans outils développeur. Autour d’un dépôt privé, tester authentification, premier envoi, restauration depuis un autre Mac et interruption entre transfert média et publication Git. Stocker les secrets dans le trousseau. Refuser un historique distant incompatible. Après une panne, reprendre la sauvegarde même sans nouvelle modification. Afficher séparément la dernière écriture locale et la dernière sauvegarde distante confirmée.
3. **Gros médias et buckets.** Valider l’import et la restauration du MP4 de 600 Mo, l’envoi multipart interrompu et la relecture de la vidéo hors ligne. Exécuter le même test avec un compte LFS sans quota disponible. Afficher le coût en octets avant un changement de destination. Aucune conversion avec perte automatique.
4. **Synchronisation bidirectionnelle ultérieure.** La sauvegarde publie des instantanés restaurables. Une future synchronisation devra définir la résolution des modifications concurrentes de deux appareils, y compris pour les corps collaboratifs. Elle aura ses propres tests de convergence avant d’être proposée dans l’interface.

Le premier jalon livrable est la restauration complète d’un seul espace sur un Mac neuf. Les transports suivants devront restaurer la même fixture avec le même résultat.

## Version de prévisualisation

Le menu **Sauvegarde de l’espace** du DMG embarqué implémente les trois transports. Le format livré utilise `workspace.json` pour les documents et leur inventaire, `attachments/` pour les originaux et `complete.sha256` pour l’empreinte du manifeste. La copie restaure l’état éditable courant sous de nouveaux identifiants. Lors de la capture, une transaction PostgreSQL lit un instantané cohérent et le journal local de chaque room est comparé à sa projection. Une projection en retard demande une nouvelle tentative.

La publication est manuelle. Git utilise la branche dédiée `blok-backup`, accepte un dépôt vide ou la sauvegarde du même espace et publie les objets LFS avant la branche. S3 publie une génération immuable puis `latest.json`. La reprise automatique après redémarrage et la synchronisation bidirectionnelle restent des évolutions. La gestion des médias et le contrôle du dépôt distant s’inspirent des décisions du desktop Tolaria. [Pièces jointes portables](https://github.com/refactoringhq/tolaria/blob/2b77b4b1d3614a8abd4b9efa6d89a3f0fa8aad52/docs/adr/0113-shared-renderer-attachment-path-normalization.md) · [Connexion d’un dépôt](https://github.com/refactoringhq/tolaria/blob/2b77b4b1d3614a8abd4b9efa6d89a3f0fa8aad52/src-tauri/src/git/connect.rs)
