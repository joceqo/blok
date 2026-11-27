import {shellPreview, type ShellTheme} from '../../../../src/stories/shell-story-fixtures';
import {createPageToolbar} from '../mount';
import type {PageBreadcrumbItem, PageToolbar, PageToolbarOptions} from '../types';
import '../../shell.css';

export type PreviewArgs = {theme: ShellTheme};
export const themeControl = {
  name: 'Thème',
  control: 'inline-radio',
  options: ['light', 'dark'],
} as const;

export const examplePages = (): PageBreadcrumbItem[] => [
  {id: 'projects', title: 'Projets', icon: '📁', onOpen: () => {}},
  {id: 'design', title: 'Navigation desktop', icon: '🎨'},
];

/**
 * La barre vit dans sa bande, sur le fond de l'application : la montrer sur
 * une page blanche cacherait les contrastes qu'elle doit tenir.
 */
export function isolated(
  theme: ShellTheme,
  signal: AbortSignal,
  items: PageBreadcrumbItem[],
  options: PageToolbarOptions = {},
  build: (toolbar: PageToolbar) => void = () => {},
) {
  const host = shellPreview(theme);
  const shell = document.createElement('div');
  shell.setAttribute('data-desktop-shell', '');
  shell.setAttribute('data-blok-theme', theme);
  const toolbar = createPageToolbar(items, false, () => {}, () => {}, undefined, options);
  build(toolbar);
  shell.append(toolbar.element);
  host.append(shell);
  signal.addEventListener('abort', () => toolbar.destroy(), {once: true});
  return host;
}
