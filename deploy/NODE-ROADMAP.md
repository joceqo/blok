# Migrer le produit Blok vers Node

Le shell web et Tauri partagent le code TypeScript de l’éditeur, des pages et de la navigation. La démo Docker utilise le même modèle de session, de permissions, d’identifiants de page et de version de document que le service Go. Un espace local Tauri reste utilisable sur disque. La connexion à un espace hébergé utilise son URL et son compte.

## Lots et critères de fusion

| Lot | Chemin utilisé | Critère pour intégrer au produit |
| --- | --- | --- |
| Shell et sauvegardes | État de sauvegarde confirmé par le serveur, attente des droits d’une page créée, protection contre une réponse de navigation tardive | Tests unitaires et édition de la même page depuis deux clients avec déconnexion puis rechargement |
| Service produit Node (#46) | Connexion par code, invitations, sessions, lecture des espaces, lecture et écriture de l’index, partage des pages, enregistrement des documents dans PostgreSQL | Même visibilité que Go pour un membre, un lecteur et une page privée. Révision et contenu lus ensemble. Rejeu identique accepté, écriture périmée refusée |
| Équipes et rôles | Annuaire, gestion des équipes, membres du workspace et changement de rôle en Node. Le shell web et Tauri donnent accès aux équipes depuis la barre latérale d’un espace distant | Une adhésion à une équipe conserve les droits individuels sur les pages. Le retrait d’un workspace nettoie ses partages et ses adhésions aux équipes |
| Reste de l’API produit (#46) | Administration d’instance, fichiers et intégrations | Porter un domaine à la fois sur le schéma canonique. Vérifier les réponses attendues par le shell et une révocation de permission avant de changer le routage Docker |
| Serveur de collaboration Node (#45) | Sur une page choisie, le shell utilise la room Node pour le journal, les WebSockets et la projection conditionnelle en base. Go émet les tickets et vérifie les droits. | Deux comptes doivent retrouver leurs changements après une coupure et un redémarrage, puis perdre l’accès dès la révocation. Pour étendre la bascule, traiter les journaux historiques, la présence et la reprise multi-page. |
| Distribution | Docker local, shell Tauri et instance distante | Même parcours d’édition sur localhost et sur une instance de recette HTTPS, avec identités isolées. Vérifier sauvegarde et restauration avant la bascule d’une instance existante |

Le chemin quotidien est `npm test`. La recette de la page confiée à Node se lance à la demande avec `./deploy/test-node-room-browser.sh`. Le parcours Docker avec la room Go reste disponible via `node desktop/src/cloud/demo-sync-smoke.mjs`. Les changements de protocole se vérifient aussi avec la suite de conformité correspondante. Le mode historique de la #46 a son propre schéma expérimental : le service du shell démarre via `dist/shell/main.js` sur le schéma canonique.

## IA et agents

| Lot parallélisable | Fonctionnement actuel | Critère pour intégrer au produit |
| --- | --- | --- |
| Assistant IA du shell | Le chat peut inclure la page ouverte ou rechercher des extraits des pages accessibles et afficher leurs liens. Le workspace distant utilise les routes Go de configuration, de modèles et de réponse. Tauri propose aussi OpenAI en local et les CLI natifs. | Porter les routes distantes sur Node en conservant les réglages personnels et partagés, les droits administrateur, le chiffrement existant et l’annulation. Tester avec un fournisseur simulé, y compris une page et un historique longs. |
| Actions sur le document | Le cœur TypeScript expose `editor.agent.ask()` et une boucle d’appels d’outils. Le shell web et Tauri proposent des actions sur la page éditable depuis le panneau et le raccourci Mod+J. | Les tests avec modèle simulé couvrent une insertion réelle, son annulation, le passage en lecture seule et une réponse tardive après navigation. |
| Agents externes via MCP | Node gère les jetons personnels (création, liste, rotation et révocation). Go sert `/mcp`. Le test croisé utilise un vrai serveur Go et PostgreSQL pour vérifier le refus d’écriture du lecteur et l’invalidation immédiate des anciens jetons. | Vérifier la parité du serveur TypeScript avec les jetons, les outils du workspace et les accès par page du service hébergé. Tester une révocation pendant une session avant de basculer le proxy. |

Pour le shell, deux parcours d’AppFlowy donnent des références distinctes. La recherche IA retourne des réponses avec des liens vers les sources du workspace. Les plugins MCP permettent à un assistant externe de travailler sur des documents. Dans Blok, la recherche filtre les pages selon les droits avant de transmettre des extraits au modèle. [Recherche IA AppFlowy](https://github.com/AppFlowy-IO/AppFlowy/blob/main/CHANGELOG.md) · [Plugins MCP AppFlowy](https://github.com/AppFlowy-IO/appflowy-ai-plugins)

## Règles du serveur de collaboration

Chez Docmost, un changement de droit déclenche une vérification des connexions déjà ouvertes sur la page. Dans la démo Blok, la mutation de partage prévient le processus propriétaire de la page et attend la revérification. Une socket inactive perd aussi son accès. Une panne du rappel renvoie une erreur après enregistrement des nouveaux droits. [Vérification des connexions dans Docmost](https://github.com/docmost/docmost/blob/c956adaa3272a9fe5899d185a16331ec9bcd65f6/apps/server/src/collaboration/extensions/authentication.extension.ts)

Dans AFFiNE, la passerelle distingue notamment le droit de mettre à jour un document de la simple participation à son espace. Ce cas guide le test Blok du lecteur qui peut ouvrir une page et reçoit un refus lorsqu’il tente d’y écrire. [Passerelle de synchronisation AFFiNE](https://github.com/toeverything/AFFiNE/blob/81da59d63d535d72ba677a097d9a0cc9a5871ade/packages/backend/server/src/core/sync/gateway.ts)

## Maintenir le fork

- Garder `joceqo/main` en avance rapide sur `JackUait/main`. Une MR destinée à l’amont doit présenter son seul correctif en comparaison directe avec ce `main`.
- Utiliser la #47 pour éprouver les lots assemblés. La #44 contient du travail en cours. Avant de promouvoir une révision en branche produit stable, examiner les correctifs propres à la #41, les tests de la fiche de ligne et les échecs CSS et d’icône déjà reproduits sur la branche d’intégration.
- Sur une branche produit durable, intégrer périodiquement le nouveau `main` par une MR de synchronisation. Comparer le schéma et le contrat de collaboration, exécuter les unités, puis le parcours Docker si la synchro ou les permissions ont changé. Conserver le commit produit validé comme point de retour.
