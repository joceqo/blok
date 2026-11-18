# Navigation des lignes et finition des tables

Branche : `feat/row-page-navigation`, créée depuis `b39a02193` sur `feat/lazy-row-bodies`.

## Priorité 1 — Le bouton du peek ouvre réellement la ligne en pleine page

- [x] Relier « Ouvrir en pleine page » à la navigation du workspace.
- [x] Donner à la destination une URL rechargeable et partageable.
- [x] Gérer les liens directs, le retour navigateur et la navigation entre deux lignes.
- [x] Afficher le titre et les propriétés de la ligne, avec un fil d’Ariane vers la page/database parente.
- [x] Résoudre les corps migrés sans les ajouter à la sidebar ni à son index enregistré.
- [x] Préserver les permissions du corps et de la source ; traiter proprement une ligne supprimée ou inaccessible.
- [x] Prévoir un comportement explicite pour les lignes dont le corps reste inline.
- [x] Vérifier que les modifications du titre, des propriétés et du corps persistent au bon endroit.

Le backend conserve déjà `parentId` et `rowBodyOf.documentId/rowId`. Les documents de corps sont volontairement absents de `index.pages`, tout en restant présents dans `index.access`. La navigation doit respecter cette séparation.

## Priorité 2 — Stabiliser le header au scroll horizontal

- [ ] Reproduire le saut avec les marges réelles de la table et les colonnes figées.
- [x] Vérifier l’alignement header/cellules avant et après l’accrochage vertical, dans les deux directions horizontales.
- [ ] Corriger la cause mesurée et conserver les menus/clics de l’en-tête.
- [x] Tenir compte du navigateur web et du WebKit de l’application macOS.

## Suite du chantier — Après ces deux corrections

- [ ] Reprofiler une ouverture à froid et une réouverture, avec et sans autre utilisateur connecté.
- [ ] Séparer les mesures du shell visible, des propriétés et du corps éditable.
- [ ] Stabiliser le skeleton : géométrie réservée, absence de contenu périmé et transition sans saut.
- [ ] Évaluer le confinement des lignes sans découper les poignées, cases à cocher ou colonnes figées ; voir `docs/table-row-containment.md`.
- [ ] Vérifier le rendement du cache et du préchargement sans concurrencer l’ouverture du peek.
- [ ] Nettoyer les sondes temporaires après conservation d’un protocole de mesure reproductible.

## Validation

Les tests/builds lourds passent par `scripts/low-memory.py`, un seul à la fois. Les travaux sont répartis entre navigation front, résolution backend et sticky ; chaque agent possède des fichiers distincts. Les cases ne sont cochées qu’après implémentation et vérification. Le déploiement reste à la charge de Joce.

## Résultats de la passe du 18 novembre 2026

- Résolution backend : 14 tests ciblés et 30 sous-tests passent avec PostgreSQL isolé, après constat d’un échec du nouveau test avant le correctif. Le contrôle d’architecture des permissions échoue encore sur `blokctlRows`, inchangé ; le même échec a été reproduit depuis `b39a02193`.
- Sticky : trois tests Chrome passent, avec marges réelles, colonnes figées, LTR/RTL, défilement horizontal à la molette et contrôles à chaque frame. Des sondes WKWebView passent également. Aucun changement de production du sticky : le saut signalé n’a pas été reproduit sur le code actuel et doit être retesté sur le déployé.
- Un test Chrome avec le vrai éditeur vérifie le bouton d’agrandissement, la sauvegarde du titre/corps, le retour navigateur et la réouverture.

Navigation implémentée : les lignes migrées utilisent leur URL `/p/<titre>-<identité publique du corps>`. Les lignes non migrées utilisent la page parente avec `?row=…&database=…`. Les liens directs restaurent la présentation de la ligne sans inscrire son corps dans la sidebar. Le titre, les propriétés et le corps restent édités par les mécanismes existants. Le retour au parent restaure son titre et sa position de défilement. Les actions de la page parente sont masquées dans cette présentation pour éviter de modifier la mauvaise page.

Validation front : 44 tests de routage/cache, 126 tests du cœur/drawer et 8 scénarios Chrome passent. La compilation web et TypeScript passe. Les nouveaux callbacks sont optionnels : les hôtes existants gardent leur comportement.

Limites : les databases imbriquées dans un corps séparé conservent la navigation pleine page du cœur ; leur routage récursif avec URL propre reste à faire. Un lien direct dont la source est elle-même un corps interne n’est pas encore résolu. Les espaces locaux conservent leur navigation existante. Le test sur l’instance déployée reste à faire après déploiement de cette branche ; aucune nouvelle migration de données n’est introduite.

Vérification élargie : `database.test.ts` contient 21 échecs et 403 succès, exactement les mêmes 21 tests en échec sur `b39a02193`, vérifiés dans la copie de synchronisation intacte. Ces échecs antérieurs ne sont pas corrigés par cette branche.

## Lignes imbriquées dans le même document

Le chemin de chargement du workspace ouvre désormais les lignes ancêtres de la destination dans l’ordre, en attendant le déplacement de chaque corps hors du pool invisible. Un changement de route annule cette attente. Le titre et le fil d’Ariane suivent la destination ; les lignes parentes du fil d’Ariane et le bouton Retour permettent de remonter la chaîne.

Le défaut a été constaté sur Sprints (refonte) : l’URL et le titre désignaient la tâche, mais son panneau avait une largeur de zéro sous deux parents masqués. `Block.call` réveillait déjà son outil ; il manquait l’ouverture des parents. Les aperçus imbriqués gardent aussi leur parent ouvert pour ne pas renvoyer leur propre table dans le pool au milieu du clic.

Le test navigateur `nested-row-navigation.browser.test.ts` utilise le vrai éditeur et le même module d’ouverture que le workspace. Il vérifie cinq niveaux, l’URL directe sans `databaseId`, le clic réel sur « Ouvrir en pleine page », le rechargement, Précédent/Suivant et l’ouverture depuis un aperçu latéral. Les ancêtres ne créent pas d’entrées d’historique ni de fragments supplémentaires. La limite des chaînes traversant plusieurs documents de corps séparés, décrite plus haut, reste distincte de ce correctif.
