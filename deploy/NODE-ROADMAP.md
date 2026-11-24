# Migrer le produit Blok vers Node

Le shell web et Tauri partagent le code TypeScript de l’éditeur, des pages et de la navigation. La démo Docker utilise le même modèle de session, de permissions, d’identifiants de page et de version de document que le service Go. Un espace local Tauri reste utilisable sur disque. La connexion à un espace hébergé utilise son URL et son compte.

## Lots et critères de fusion

| Lot | Chemin utilisé | Critère pour intégrer au produit |
| --- | --- | --- |
| Shell et sauvegardes | État de sauvegarde confirmé par le serveur, attente des droits d’une page créée, protection contre une réponse de navigation tardive | Tests unitaires et édition de la même page depuis deux clients avec déconnexion puis rechargement |
| Service produit Node (#46) | Sessions, lecture des espaces, lecture et écriture de l’index, partage des pages, enregistrement des documents dans PostgreSQL | Même visibilité que Go pour un membre, un lecteur et une page privée. Révision et contenu lus ensemble. Rejeu identique accepté, écriture périmée refusée |
| Équipes et rôles | Annuaire, gestion des équipes, membres du workspace et changement de rôle en Node. Le shell web et Tauri donnent accès aux équipes depuis la barre latérale d’un espace distant | Une adhésion à une équipe conserve les droits individuels sur les pages. Le retrait d’un workspace nettoie ses partages et ses adhésions aux équipes |
| Reste de l’API produit (#46) | Connexion, invitations et administration, fichiers et intégrations | Porter un domaine à la fois sur le schéma canonique. Vérifier les réponses attendues par le shell et une révocation de permission avant de changer le routage Docker |
| Serveur de collaboration Node (#45) | Lecture des documents en cours de revue dans la #50. Restent le journal, le rejeu, les WebSockets avec accusés et la restauration | Vérifier deux clients, une coupure, puis un redémarrage du serveur avec les mêmes volumes. Comparer contenu, versions et droits avant de remplacer le processus Go |
| Distribution | Docker local, shell Tauri et instance distante | Même parcours d’édition sur localhost et sur une instance de recette HTTPS, avec identités isolées. Vérifier sauvegarde et restauration avant la bascule d’une instance existante |

Le chemin quotidien est `npm test`. Le test navigateur de la démo s’exécute à la demande avec `node desktop/src/cloud/demo-sync-smoke.mjs`. Les changements de protocole se vérifient aussi avec la suite de conformité correspondante. Le mode historique de la #46 a son propre schéma expérimental : le service du shell démarre via `dist/shell/main.js` sur le schéma canonique.

## Maintenir le fork

- Garder `joceqo/main` en avance rapide sur `JackUait/main`. Une MR destinée à l’amont doit présenter son seul correctif en comparaison directe avec ce `main`.
- Utiliser la #47 pour éprouver les lots assemblés. La #44 contient du travail en cours. Avant de promouvoir une révision en branche produit stable, examiner les correctifs propres à la #41, les tests de la fiche de ligne et les échecs CSS et d’icône déjà reproduits sur la branche d’intégration.
- Sur une branche produit durable, intégrer périodiquement le nouveau `main` par une MR de synchronisation. Comparer le schéma et le contrat de collaboration, exécuter les unités, puis le parcours Docker si la synchro ou les permissions ont changé. Conserver le commit produit validé comme point de retour.
