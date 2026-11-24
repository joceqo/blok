# Blok self-host

Ce déploiement sert le navigateur et les clients Tauri sur ton domaine HTTPS.
nginx sert l’interface web et transmet les requêtes aux services TypeScript. PostgreSQL 17 conserve les données du shell. Le proxy du VPS termine HTTPS.

## Démonstration sur ton ordinateur

```sh
./deploy/demo.sh start
```

Ouvre [Blok local](http://localhost:8088) et la [boîte mail locale](http://localhost:8089).
Connecte-toi avec `admin@example.test` pour administrer, `membre@example.test` pour le membre déjà ajouté, ou `demandeur@example.test` pour demander à rejoindre l'espace.
Chaque connexion envoie un code neuf dans cette boîte locale. Aucun e-mail réel n'est envoyé. Utilise deux fenêtres privées/profils de navigateur pour comparer les rôles en même temps.

`./deploy/demo.sh stop` arrête la démo sans effacer les données ; `./deploy/demo.sh status` affiche les conteneurs.
Cette pile distincte (`blok-local`) est limitée à l'ordinateur via `127.0.0.1`. La boîte mail donne accès aux codes : elle est uniquement destinée à la démonstration locale. Le déploiement public ci-dessous utilise ton relais SMTP et ne contient pas ce service.

### Services Node de la démo

Tous les workspaces et leurs nouvelles pages utilisent Node dès le démarrage. Le navigateur et Tauri conservent les mêmes URL de page. Une seule instance du service `room` doit détenir les journaux du volume `state`.

| Service | Responsabilité |
| --- | --- |
| `app` | Comptes, courrier, workspaces, permissions, tickets, métadonnées, projections PostgreSQL et autorisation des accès aux fichiers |
| `room` | Connexions WebSocket, journal durable des modifications et reprise après reconnexion |
| `media` | Import, stockage et lecture des pièces jointes via l’API authentifiée |
| `web` | Interface du shell et routage HTTP |

Pour observer une reconnexion, ouvre une page sur deux navigateurs puis lance `./deploy/demo.sh compose restart room`. Les journaux et les documents sont conservés dans les volumes Docker. Un ancien journal BKW2 doit être au format éditeur 2 et cohérent avec PostgreSQL pour être importé. Arrête le processus de l’ancienne installation avant de transférer ses données.

Pour démarrer une démo distincte, utilise un fichier d’environnement, un nom de projet, deux ports et un préfixe réseau disponibles.

```sh
export DEMO_ENV_FILE=/tmp/blok-node-review.env
export COMPOSE_PROJECT_NAME=blok-node-review
export DEMO_WEB_PORT=18098 DEMO_MAIL_PORT=18099 DEMO_NETWORK_PREFIX=172.30.91
./deploy/demo.sh start
```

## Construire les images sur ton VPS

Prérequis : Git, Docker avec Compose v2, OpenSSL et un proxy HTTPS existant pour le domaine.
Fais pointer le DNS A de ton domaine vers le VPS choisi ; retire un éventuel AAAA qui pointe ailleurs.
Le seul port publié par Blok est `127.0.0.1:18088`. Configure ton proxy existant pour transmettre ton domaine vers `http://127.0.0.1:18088`, en conservant Host et les connexions WebSocket. Le port 18088 est local uniquement ; les ports 80, 443 et 5432 existants ne sont pas utilisés par Blok.

```sh
git clone https://github.com/joceqo/blok.git
cd blok
./deploy/install.sh
```

Le premier lancement crée `deploy/.env` et trois secrets aléatoires, puis s'arrête.
Édite ce fichier sur le serveur :

```dotenv
DOMAIN=blok.example.com
BOOTSTRAP_ADMIN_EMAIL=ton-adresse@example.com
# Optional: seed one workspace at first boot (both or neither).
BOOTSTRAP_WORKSPACE_SLUG=equipe
BOOTSTRAP_WORKSPACE_NAME=Équipe
MAILER_HOST=smtp.example.com
MAILER_PORT=465
MAILER_USER=
MAILER_PASSWORD=
MAILER_FROM_EMAIL=blok@example.com
MAILER_FROM_NAME=blok
```

Ne remplace pas les trois secrets générés. Le mot de passe PostgreSQL doit rester hexadécimal pour son utilisation dans l'URL de connexion.
Le fichier `.env` est ignoré par Git. Garde-en une copie privée hors du VPS.

Le port **465** utilise TLS dès la connexion, avec validation du certificat. Renseigne `MAILER_USER` et `MAILER_PASSWORD` si ton relais exige une authentification ; laisse les deux vides uniquement si le relais autorise ton serveur sans identifiants. L’expéditeur `MAILER_FROM_EMAIL` doit être autorisé par le relais. Aucun envoi réel n’est effectué par le script d’installation : la première demande de connexion permet de vérifier la livraison.

Dans `.env`, une ligne par variable, **sans antislash final**. Un mot de passe contenant `$` ou `#` doit être entouré d’apostrophes pour rester littéral, par exemple `MAILER_PASSWORD='valeur-à-remplacer'`. Ne publie pas ce fichier.

Dans Compose, les valeurs `MAILER_*` non vides sont prioritaires ; les anciens noms `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` et `SMTP_FROM` restent acceptés. Quand un hôte SMTP est configuré, SMTP est utilisé. Sans hôte SMTP, `RESEND_API_KEY` et `MAIL_FROM` permettent encore d’utiliser Resend.

```sh
cd deploy
sudo docker compose up -d --build --wait --wait-timeout 180
sudo docker compose ps
sudo docker compose logs --tail 100 app web
```

Le proxy existant gère le certificat HTTPS public. nginx écoute en HTTP sur le port 80 du conteneur, publié uniquement sur `127.0.0.1:18088`. `PUBLIC_URL` reste l’adresse HTTPS du domaine. Vérifie la pile depuis le VPS avec `curl http://127.0.0.1:18088/healthz`.
Sans `BOOTSTRAP_ADMIN_EMAIL`, le premier démarrage ouvre l'assistant de setup : ouvrez l'adresse de l'instance, saisissez le nom de l'instance, votre nom et votre adresse, et l'espace de départ. Il n'y a pas de jeton à aller chercher.

> **Configurez l'instance tout de suite après l'avoir démarrée.** Tant que l'assistant n'a pas été complété, **la première personne qui atteint cette adresse revendique l'instance** et en devient l'administratrice. La revendication n'ouvre aucune session — un code de connexion part à l'adresse saisie, donc il faut en contrôler la boîte — mais ne laissez pas une instance fraîche exposée sans la configurer. Le service le rappelle dans ses logs à chaque démarrage tant que le setup est en attente.
 Avec cette variable seule, l'adresse devient administrateur d'instance sans membership d'espace. Le couple `BOOTSTRAP_WORKSPACE_*` (avec l'admin) sème un espace et une membership admin une fois chacun (`ON CONFLICT DO NOTHING` — une rétrogradation volontaire survit au redémarrage).

Si le réseau Docker `172.30.87.0/24` existe déjà, change ensemble `BLOK_NETWORK_SUBNET`, `BLOK_NETWORK_DYNAMIC_RANGE` et `CADDY_IP` dans `.env`. L'adresse fixe de nginx doit rester hors de la plage dynamique.
Seul nginx est un proxy de confiance ; les ports PostgreSQL et Node sont internes au réseau Compose.

## Utiliser des images préconstruites

Les services `app`, `room` et `media` utilisent la même image Node. Le shell web utilise sa propre image nginx. Pour préparer un paquet depuis ce checkout sur une machine équipée de Docker Buildx, choisis l’architecture de destination.

```sh
./deploy/package-images.sh ./blok-vps-amd64 linux/amd64
```

Pour un VPS ARM, passe `linux/arm64`. Le répertoire de sortie contient les deux images Docker dans `images.tar`, le fichier Compose autonome, les tags dans `.env.example`, le commit source et les scripts d’exploitation. Copie-le sur le VPS, puis lance les commandes suivantes dans ce répertoire. La première exécution de `install.sh` génère le fichier `.env`.

```sh
docker load -i images.tar
./install.sh
nano .env
./install.sh
```

PostgreSQL utilise l’image officielle. Conserve le paquet correspondant à chaque sauvegarde.

### Administration depuis le serveur

Le CLI TypeScript permet d’intervenir avec un accès administrateur au conteneur, y compris lorsqu’une connexion au shell est impossible.

```sh
./deploy/stack.sh exec app blokctl admin list
./deploy/stack.sh exec app blokctl admin grant admin@example.com
./deploy/stack.sh exec app blokctl settings show
./deploy/stack.sh exec app blokctl settings set signup-policy=invite
./deploy/stack.sh exec app blokctl email test admin@example.com
```

## Membres et administration

Un nouvel utilisateur vérifie son e-mail, puis demande à rejoindre un espace (ou reçoit une invitation).
Un administrateur peut approuver/refuser la demande, inviter par e-mail, changer un rôle ou retirer un membre.
L'invitation devient effective à la prochaine connexion avec l'adresse invitée.

Dans l'éditeur, le menu de l'espace ouvre **Paramètres** dans une dialog avec navigation à gauche. Les préférences, le compte et les accès sont réunis dans cette fenêtre ; sa fermeture rend la main à la page ouverte.
**Inviter des membres** ouvre une dialog compacte avec les adresses séparées par des virgules, le rôle et un message facultatif (2 000 caractères maximum). Les invitations réussies ne sont pas renvoyées lorsqu'on réessaie après un échec partiel.

| Rôle | Accès |
| --- | --- |
| Administrateur | Pages et gestion des membres/invitations/demandes |
| Membre | Lecture et modification des pages de l'espace |
| Lecteur | Lecture des pages de l'espace |

Le dernier administrateur du workspace conserve son rôle. Le partage d’une page privée se gère sur cette page. L’administration d’instance se gère séparément dans les paramètres du serveur.
Le schéma de gestion des membres s'inspire du parcours [Paramètres → Membres de Notion](https://www.notion.com/help/add-members-admins-guests-and-groups), avec des rôles simplifiés.

## Tauri et espaces locaux

La même interface peut se lancer dans Tauri. Depuis les réglages, connecte un serveur HTTPS et vérifie ton e-mail pour ouvrir un espace partagé.
Les sessions natives sont conservées dans le trousseau du système. Les données d'un espace local restent sur la machine, séparées des espaces serveur et des autres comptes.
Changer d'espace attend les écritures en cours ; une synchronisation distante impossible bloque le changement pour éviter de perdre une modification.
Le démarrage d'un espace serveur demande une connexion réseau. Les espaces locaux fonctionnent hors ligne ; leur contenu n'est pas automatiquement publié vers le serveur.

Pour compiler Tauri avec Node, Rust et les dépendances natives de la plateforme installés :

```sh
corepack enable
yarn install --immutable
npm ci --prefix desktop
npm run tauri --prefix desktop -- build
```

## Où sont les données ?

| Volume Docker | Contenu |
| --- | --- |
| `blok-cloud_postgres` | Utilisateurs, sessions, espaces, rôles, index des pages, projections du contenu et clés OpenAI chiffrées |
| `blok-cloud_state` | Journal durable de collaboration `/data/collab`, fichiers joints `/data/uploads` et clé de chiffrement `/data/ai-key` |

Les images contiennent le programme. Les volumes contiennent les données et survivent à leur remplacement.
**La base seule ne suffit pas à sauvegarder les documents : conserve aussi le volume `state`.**
Ne lance pas `docker compose down -v` sur une installation à conserver.

## Sauvegarde et mise à jour

```sh
./deploy/backup.sh
# Après récupération et revue de la nouvelle version du code :
./deploy/upgrade.sh
```

La sauvegarde arrête d’abord les accès publics, puis laisse la collaboration terminer ses écritures avec l’API disponible. Elle arrête ensuite les médias et l’API, vérifie leurs codes de sortie, exporte PostgreSQL et archive `/data`. Les services actifs avant la sauvegarde redémarrent ensuite.
Elle écrit `deploy/backups/<date>/` avec `database.dump`, `state.tar.gz`, le commit et les images utilisés, et un marqueur `complete`.
Copie ce dossier hors du VPS et conserve séparément `.env`. Les sauvegardes incluent des sessions et des données privées : garde-les privées.
Le script de mise à jour construit les images pendant que la version en cours répond. Il sauvegarde ensuite le serveur, garde les écritures arrêtées et démarre la nouvelle version. Il ne fait pas de `git pull` ni de choix de branche à ta place.

Le schéma PostgreSQL est initialisé et mis à niveau dans une transaction au démarrage, avec verrou contre les démarrages concurrents.
Pour les futures évolutions, ajoute des migrations compatibles aux versions de schéma ; ne remplace jamais les volumes pour mettre le code à jour.
Une image ancienne n'est pas nécessairement compatible avec un schéma plus récent : un retour complet utilise la sauvegarde et le code correspondant.

## Changer de VPS / restauration

1. Fais une sauvegarde finale sur l'ancien VPS. Arrête ensuite les services avec `./deploy/stack.sh stop web room media app` et garde-les arrêtés pour éviter deux installations divergentes.
2. Copie le dossier de sauvegarde complet et `.env` vers le nouveau VPS. Récupère le commit indiqué dans `source-commit`.
3. Construis ou charge les images dans la destination vide, puis restaure.

```sh
./deploy/stack.sh build --pull
./deploy/restore.sh /chemin/absolu/vers/la/sauvegarde
```

4. Fais pointer le DNS vers le nouveau VPS, vérifie la connexion, une page existante et une pièce jointe.

La restauration refuse une base ou un volume de données non vide. Elle ne supprime rien pour forcer le passage.
Si elle échoue après avoir commencé, conserve la sauvegarde et inspecte les logs avant de reprendre sur une destination vide.
En gardant le même domaine et les secrets, les liens et identités restent cohérents. Changer aussi le domaine nécessite de migrer les URL absolues des pièces jointes.
Les certificats sont gérés par le proxy existant ; les données locales Tauri d'un ordinateur ne font pas partie de la sauvegarde serveur.

## Vérifications de développement

L'API est documentée dans `apps/service/API.md`. Les tests rapides Node et du shell se lancent avec `npm test`. La recette Docker à deux navigateurs se lance à la demande avec `./deploy/test-node-room-browser.sh --workspace`.
Le collecteur exige explicitement `APP_ENV=development` et `DEV_MAIL_DIRECTORY`; il est interdit en production.
Le scénario navigateur est `desktop/src/cloud/browser-e2e.mjs` (voir ses variables au début du fichier).


## Assistant OpenAI

Dans **Paramètres → Assistant IA**, chaque membre peut enregistrer sa clé OpenAI et choisir son modèle. Les administrateurs peuvent aussi configurer une clé et un modèle partagés pour le workspace. La clé personnelle est prioritaire sur la clé partagée ; une erreur de clé personnelle ne déclenche jamais un repli facturé au workspace. Retirer la clé personnelle réactive la clé partagée si elle existe.

Le sélecteur de l’assistant affiche le fournisseur, le modèle et la provenance de la clé. Il permet de choisir un autre modèle de texte accessible à la clé. Aucun appel de génération ne part avant l’envoi d’une demande. Le catalogue vient d’OpenAI ; la présence d’un modèle ne garantit pas sa compatibilité avec toutes les options de Responses.

Les secrets ne sont jamais renvoyés au navigateur ni conservés dans son localStorage. Le serveur chiffre les clés avec AES-GCM. Par défaut, il crée une clé aléatoire dans `/data/ai-key` (permissions 0600), incluse dans `state.tar.gz`. **Conserver ce fichier avec la base est indispensable pour retrouver les clés après restauration ou changement de VPS.** Si `AI_ENCRYPTION_KEY` est défini, il doit contenir 32 octets aléatoires encodés en base64 ; conservez alors cette variable avec les secrets du déploiement. La changer ne rechiffre pas les clés existantes.

Dans l’app macOS, un espace en ligne utilise le même compte et les mêmes règles que le navigateur. Un espace local utilise une clé personnelle distincte dans le trousseau du Mac. Codex et Claude Code restent disponibles via leur connexion CLI sur le Mac. Les clés du trousseau ne sont pas dans la sauvegarde serveur.

La demande et le contexte de page explicitement activé sont envoyés à OpenAI via le serveur (ou directement depuis la partie native pour un espace local), avec `store: false`. Les appels sont facturés par OpenAI au titulaire de la clé utilisée. Les tests automatisés simulent OpenAI et ne nécessitent aucune clé réelle.

### React Grab dans la démo locale

La cible web accepte l’argument de build `VITE_REACT_GRAB=true`. Il est activé dans `compose.demo.yaml` et désactivé par défaut pour le serveur. Dans les réglages de la démo, « Sélectionner un élément » lance React Grab ; le raccourci est `⌘/Ctrl + Maj + G`. Collez ensuite le contexte dans le chat. La télémétrie de React Grab est désactivée. Les réglages étant écrits en DOM, le contexte inclut leur fichier source et le HTML sélectionné, sans inventer de pile de composants React.
