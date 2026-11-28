# Écrire les composants TSX du desktop

La sidebar applique ces conventions dans `src/sidebar/`, `src/sidebar-mode-item.tsx` et `src/sidebar-modes.tsx`. Ses stories utilisent le même formatage.

## Shell et calendrier

- Dans le shell web et Tauri, importer les boutons et menus depuis `src/components/index.ts`. Leur apparence est définie dans `src/components/shell/`.
- Dans le calendrier, utiliser `src/calendarcn/components/ui/`. Son thème et le conteneur de ses portails lui appartiennent.
- Les deux menus utilisent `src/components/primitives/menu-surface.tsx` pour leur comportement Base UI. Le déclencheur sert d’ancre par défaut, `sideOffset` règle la distance en pixels et `container` choisit où monter le menu.

### Couverture actuelle du shell

| Famille | Où elle vit aujourd’hui |
| --- | --- |
| Boutons, menus et contrôles de formulaire | Importer `Button`, `DropdownMenu`, `TextField`, `SearchField`, `Choice` et `SwitchRow` depuis `src/components/index.ts`. |
| Identité, états vides et messages | Utiliser `Avatar`, `EmptyState` et `Feedback`. Pour les écrans DOM, `src/components/dom.ts` expose les fabriques existantes et leur cycle de vie. |
| Couleurs, espacements, rayons et focus | Les composants reprennent les variables de `src/shell.css` et `../src/styles/colors.css`. |
| Infobulle | Envelopper le bouton ou le lien dans `Tooltip`. L’enfant sert d’ancre. `side` et `sideOffset` règlent la position, et Base UI gère le survol, le focus et Échap. |
| En-tête de section | `SectionHeader` reçoit le titre, l’état ouvert et le rappel de bascule. Chaque `SectionAction` fournit une action nommée avec son infobulle. |
| Sidebar | `src/sidebar/sidebar.tsx` compose la navigation. `sidebar-footer.tsx` reçoit les actions et les espaces. Le contrôleur des réglages conserve les appels serveur et les permissions. |
| Storybook | Les contrôles du shell sont dans `src/components/shell/stories/`. Les sous-composants, la sidebar complète et sa référence visuelle sont dans `src/sidebar/stories/`. |

## Composants et props

- Déclarer les composants avec une constante en PascalCase et une fonction fléchée. Les fonctions utilitaires et les gestionnaires d’événements peuvent garder une déclaration `function`.
- Donner un nom aux props quand leur type gêne la lecture du composant. Choisir les noms du domaine, comme `label`, `kind` ou `onSelect`.
- Pour un choix fermé d’icônes, définir la table au niveau du module et la typer avec `satisfies Record<Kind, LucideIcon>`. TypeScript signale une variante oubliée. Dans le composant, lire l’entrée dans une variable en PascalCase que JSX peut rendre.
- Garder le JSX de composition lisible d’un coup d’œil. Extraire un sous-composant quand une partie de l’interface se répète ou a son propre comportement. Garder le nom accessible, la navigation clavier et l’action auprès du contrôle qui les utilise.

Exemple de menu dans le shell

```tsx
<DropdownMenu>
  <DropdownMenuTrigger render={<Button />}>Mon espace</DropdownMenuTrigger>
  <DropdownMenuContent side="top" align="start" sideOffset={8}>
    <DropdownMenuItem onClick={openSettings}>Paramètres</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

## Formater et vérifier

Depuis le dossier `desktop/` :

| Commande | Effet |
| --- | --- |
| `npm run format` | Formate les fichiers TypeScript et TSX de la sidebar et de `src/components/`, stories comprises. |
| `npm run format:check` | Vérifie leur mise en forme sans écrire. |
| `npm run lint:fast` | Lance les règles Biome sur le même périmètre. |
| `npm exec -- biome format --write src/sidebar/sidebar-footer.tsx` | Formate uniquement le fichier indiqué. |

Biome applique deux espaces d’indentation, une largeur cible de 100 colonnes, les guillemets simples en TypeScript et doubles dans le JSX, et répartit les attributs JSX sur plusieurs lignes. ESLint vérifie la convention des composants fléchés dans la sidebar de production. Depuis la racine du dépôt, `yarn lint` lance les règles ESLint du projet et la vérification TypeScript.
