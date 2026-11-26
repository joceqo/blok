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


## Décision A — Corps ouvrable comme document (24 novembre 2026)

L’URL publique ou historique d’un corps ouvre désormais une session sur ce corps.
L’éditeur, le diagnostic de synchronisation, le partage et l’historique utilisent
son identité. Les métadonnées résolues restent en mémoire, séparées de
`index.pages` ; les droits viennent toujours de l’index courant. Le retrait de
l’accès ferme la session. Un partage portant uniquement sur le corps fonctionne
sans dévoiler son parent.

Le tiroir reste un accès éditable au même contenu. En mode local, le passage au
document ferme les éditeurs du parent avant de monter celui du corps, pour ne
pas écrire le même fichier depuis deux éditeurs. Les modifications du tiroir
sont explicitement collectées avant ce passage. Les lignes encore inline
conservent leur route `?row=…&database=…` et le masquage des actions de l’hôte.
La création d’un corps pendant l’édition d’une ligne inline ne remplace plus
silencieusement son URL : l’ouverture explicite change à la fois l’URL et la
session.

Le titre et l’icône du document sont enregistrés avec son contenu ; le serveur
projette déjà le titre dans ses métadonnées. Le libellé et les propriétés de la
ligne restent gérés dans la database et son tiroir. La préférence de pleine
largeur du document est personnelle, mémorisée sur cet appareil. Les favoris
restent personnels et ne publient pas le corps dans la sidebar.

Le menu propose les actions compatibles : copier le lien, renommer le document,
dupliquer son contenu en page ordinaire, historique (à distance) et pleine
largeur. Le partage cible le corps. Déplacer le corps et le mettre isolément à
la corbeille ne sont pas proposés : il reste attaché à sa ligne, et les règles
de sidebar, recherche, corbeille et déplacements n’ont pas changé. La gestion
de la ligne reste disponible depuis la database et le tiroir.

Le bloc `/page` utilise la création de page existante. À distance, le parent
physique peut être le corps ; localement, la page est indexée sous l’ancêtre du
workspace, comme pour les sous-pages créées depuis le tiroir. Le corps ne devient
pas une entrée d’index. Aucune migration de données n’est ajoutée.

Validation finale ciblée : 59 tests passent, dont un parcours Chromium avec
l’éditeur réel, ainsi que le contrôle TypeScript du desktop. La duplication
locale prend les dernières modifications ; un corps non modifié dans un
tiroir ne réécrit pas une version externe plus récente. Les tests ont été
écrits et vus en échec avant les correctifs correspondants.

Les commandes complètes `yarn lint` et `yarn test` ont été lancées sous la
limite de 2 Go du dépôt et ont échoué par épuisement du tas Node. Le lint
ciblé conserve les 36 diagnostics préexistants, vérifiés contre les copies
initiales dans un miroir séparé. Une exécution complète des tests desktop
compte 712 succès, 14 échecs hors de cette modification et un test ignoré :
10 échecs viennent du WebKit Playwright absent, les quatre autres de la
hauteur des onglets et de règles d’architecture sur des fichiers inchangés
par cette session. La validation globale n’est donc pas acquise. Le
déploiement et la vérification de l’instance restent à faire.
