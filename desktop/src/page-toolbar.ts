/**
 * La barre du haut vit maintenant dans `top-bar/`, en TSX sur Base UI. Ce
 * fichier garde le chemin d'import que le reste de l'application connaît.
 */
export {createPageToolbar} from './top-bar/mount';
export type {PageBreadcrumbChoice, PageBreadcrumbItem, PageToolbar, PageToolbarOptions} from './top-bar/types';
