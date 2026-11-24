# Migrer le produit Blok vers Node

Le shell web et Tauri partagent le code TypeScript de l’éditeur, des pages et de la navigation. La démo Docker utilise le même modèle de session, de permissions, d’identifiants de page et de version de document que le service Go. Un espace local Tauri reste utilisable sur disque. La connexion à un espace hébergé utilise son URL et son compte.

## Services du shell

Les images Docker font tourner l’API, la collaboration et les médias en Node. nginx transmet tous les WebSockets de document au service de collaboration. Chaque connexion et chaque nouvelle ouverture vérifient les droits de la page. Les identifiants, les sessions, les journaux et le schéma PostgreSQL existants servent à la reprise des installations.

| Domaine | Fonctionnement |
| --- | --- |
| Comptes et espaces | Connexion par code, invitations, équipes, rôles, partage par page et administration d’instance |
| Collaboration | Tickets et droits en direct, présence, consultation et restauration des versions, journal et projection PostgreSQL pour tous les workspaces |
| Médias | Pièces jointes privées, lecture par plages, liens temporaires, images du workspace et emojis |
| Courrier | Livraison du code et des invitations via SMTP, Resend ou la boîte locale de développement |
| Exploitation | Même image pour API, collaboration et médias, CLI Node `blokctl`, sauvegarde du journal avec la base et restauration sur une installation vide |

Le chemin quotidien est `npm test`. La recette complète à deux navigateurs est opt-in via `./deploy/test-node-room-browser.sh --workspace`. Les suites de conformité des moteurs historiques restent disponibles pour comparer les formats et les contrats.

Le shell ouvre l’historique depuis le menu « Actions de la page ». La room accepte les clients Blok v1 et v2 au format éditeur 2. Le protocole v2 confirme la persistance de chaque opération. La purge intégrale d’une page, les notes d’activité historiques des agents et le détail des différences champ par champ dans les bases restent à porter.

## IA et agents

Les paramètres IA du workspace distant et le transport MCP hébergé résident dans le service Node. Le shell utilise les droits de l’utilisateur pour choisir les sources de contexte. Les espaces locaux Tauri gardent leur configuration et leur trousseau propres. Le parcours d’édition assistée permet d’annuler une opération et doit respecter la lecture seule après une navigation ou une révocation.

Pour le shell, deux parcours d’AppFlowy donnent des références distinctes. La recherche IA retourne des réponses avec des liens vers les sources du workspace. Les plugins MCP permettent à un assistant externe de travailler sur des documents. Dans Blok, la recherche filtre les pages selon les droits avant de transmettre des extraits au modèle. [Recherche IA AppFlowy](https://github.com/AppFlowy-IO/AppFlowy/blob/main/CHANGELOG.md) · [Plugins MCP AppFlowy](https://github.com/AppFlowy-IO/appflowy-ai-plugins)

## Règles du serveur de collaboration

Chez Docmost, un changement de droit déclenche une vérification des connexions déjà ouvertes sur la page. Dans la démo Blok, la mutation de partage prévient le processus propriétaire de la page et attend la revérification. Une socket inactive perd aussi son accès. Une panne du rappel renvoie une erreur après enregistrement des nouveaux droits. [Vérification des connexions dans Docmost](https://github.com/docmost/docmost/blob/c956adaa3272a9fe5899d185a16331ec9bcd65f6/apps/server/src/collaboration/extensions/authentication.extension.ts)

Dans AFFiNE, la passerelle distingue notamment le droit de mettre à jour un document de la simple participation à son espace. Ce cas guide le test Blok du lecteur qui peut ouvrir une page et reçoit un refus lorsqu’il tente d’y écrire. [Passerelle de synchronisation AFFiNE](https://github.com/toeverything/AFFiNE/blob/81da59d63d535d72ba677a097d9a0cc9a5871ade/packages/backend/server/src/core/sync/gateway.ts)

## Maintenir le fork

- Garder `joceqo/main` en avance rapide sur `JackUait/main`. Une MR destinée à l’amont doit présenter son seul correctif en comparaison directe avec ce `main`.
- Utiliser la #47 pour éprouver les lots assemblés. La #44 contient du travail en cours. Avant de promouvoir une révision en branche produit stable, examiner les correctifs propres à la #41, les tests de la fiche de ligne et les échecs CSS et d’icône déjà reproduits sur la branche d’intégration.
- Sur une branche produit durable, intégrer périodiquement le nouveau `main` par une MR de synchronisation. Comparer le schéma et le contrat de collaboration, exécuter les unités, puis le parcours Docker si la synchro ou les permissions ont changé. Conserver le commit produit validé comme point de retour.
