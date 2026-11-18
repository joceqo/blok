# Navigation des lignes et finition des tables

Branche : `feat/row-page-navigation`, créée depuis `b39a02193` sur `feat/lazy-row-bodies`.

## Priorité 1 — Le bouton du peek ouvre réellement la ligne en pleine page

- [ ] Relier « Ouvrir en pleine page » à la navigation du workspace.
- [ ] Donner à la destination une URL rechargeable et partageable.
- [ ] Gérer les liens directs, le retour navigateur et la navigation entre deux lignes.
- [ ] Afficher le titre et les propriétés de la ligne, avec un fil d’Ariane vers la page/database parente.
- [ ] Résoudre les corps migrés sans les ajouter à la sidebar ni à son index enregistré.
- [ ] Préserver les permissions du corps et de la source ; traiter proprement une ligne supprimée ou inaccessible.
- [ ] Prévoir un comportement explicite pour les lignes dont le corps reste inline.
- [ ] Vérifier que les modifications du titre, des propriétés et du corps persistent au bon endroit.

Le backend conserve déjà `parentId` et `rowBodyOf.documentId/rowId`. Les documents de corps sont volontairement absents de `index.pages`, tout en restant présents dans `index.access`. La navigation doit respecter cette séparation.

## Priorité 2 — Stabiliser le header au scroll horizontal

- [ ] Reproduire le saut avec les marges réelles de la table et les colonnes figées.
- [ ] Vérifier l’alignement header/cellules avant et après l’accrochage vertical, dans les deux directions horizontales.
- [ ] Corriger la cause mesurée et conserver les menus/clics de l’en-tête.
- [ ] Tenir compte du navigateur web et du WebKit de l’application macOS.

## Suite du chantier — Après ces deux corrections

- [ ] Reprofiler une ouverture à froid et une réouverture, avec et sans autre utilisateur connecté.
- [ ] Séparer les mesures du shell visible, des propriétés et du corps éditable.
- [ ] Stabiliser le skeleton : géométrie réservée, absence de contenu périmé et transition sans saut.
- [ ] Évaluer le confinement des lignes sans découper les poignées, cases à cocher ou colonnes figées ; voir `docs/table-row-containment.md`.
- [ ] Vérifier le rendement du cache et du préchargement sans concurrencer l’ouverture du peek.
- [ ] Nettoyer les sondes temporaires après conservation d’un protocole de mesure reproductible.

## Validation

Les tests/builds lourds passent par `scripts/low-memory.py`, un seul à la fois. Les travaux sont répartis entre navigation front, résolution backend et sticky ; chaque agent possède des fichiers distincts. Les cases ne sont cochées qu’après implémentation et vérification. Le déploiement reste à la charge de Joce.
