# Tableau blanc d’une page Blok

## Référence produit

La référence est la page **Getting Started** de la version auto-hébergée AFFiNE 0.27.4, en mode Edgeless. À 10 % de zoom, on voit la note principale entourée d’autres notes et d’images. À droite, un organigramme dispose de sa propre légende. La barre d’outils se trouve au bas du tableau. La sidebar et le titre appartiennent toujours à l’espace et à la page.

Dans l’onglet examiné, 10 composants de note, 16 composants d’image Edgeless et deux cadres sont montés. La note principale, large de 800 unités, contient notamment trois bases de données. Le JSON du modèle de démonstration fourni par le conteneur est disponible dans le dépôt amont. Son archive et celle du conteneur ont la même empreinte SHA-256. Les identifiants du modèle diffèrent de ceux attribués lors de son import dans le navigateur. [Modèle Getting Started de la version installée](https://github.com/toeverything/AFFiNE/blob/v0.27.4/packages/frontend/templates/onboarding/onboarding.zip)

## Organisation des données et rendu

- La racine du modèle contient dix blocs `affine:note` et un bloc `affine:surface`. Chaque note possède ses blocs enfants et un rectangle `xywh` dans le repère du tableau. Deux notes ont `displayMode: both`, les huit autres `edgeless`. L’ordre de lecture des blocs enfants et la position de la note sont deux informations indépendantes. [Modèle de note](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/affine/model/src/blocks/note/note-model.ts)
- La surface contient des blocs enfants pour les images, les cadres ou les documents incorporés. Son dictionnaire `elements` contient 36 connecteurs, 19 formes, 13 groupes, huit textes et une carte mentale. Un connecteur peut désigner l’identifiant d’une note et un point relatif sur son bord. [Modèle de surface](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/affine/blocks/surface/src/surface-model.ts)
- Le composant de note monte les blocs éditables à l’endroit déterminé par le rectangle et la caméra. Il distingue la sélection de l’objet de l’édition de son contenu. La caméra convertit les coordonnées du pointeur en coordonnées du tableau. [Rendu de la note](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/affine/blocks/note/src/note-edgeless-block.ts) · [Viewport](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/framework/std/src/gfx/viewport.ts)

## Implémentation Blok

En vue Tableau blanc, la note principale accueille le titre et l’éditeur de la page. Sa position est enregistrée au premier déplacement. Les anciens marquages de paragraphes restent lisibles dans le format enregistré. Les objets ajoutés par la palette sont des blocs `whiteboardElement` qui portent les coordonnées du tableau. La vue Document masque ces blocs. Une flèche conserve les identifiants de ses cibles et recalcule ses extrémités quand elles bougent. Le zoom, le défilement et la sélection appartiennent à la fenêtre.

Le scénario **Palette** de Storybook permet de manipuler un exemple. **Édition et réouverture** vérifie l’édition du texte riche et d’une note. Le [test de stockage](../../packages/server/node/src/collab/room/page-whiteboard.fast.test.ts) couvre la fusion et la restauration des modèles. Une vérification dans deux applications distantes reste à faire.
