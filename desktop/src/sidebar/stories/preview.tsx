import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ShellPage } from '@blok/sidebar';
import { shellPreview, type ShellTheme } from '../../../../src/stories/shell-story-fixtures';
import '../../../../src/shell/sidebar.css';
import '../../navigation-dialogs.css';
import '../../sidebar-modes.css';

export type PreviewArgs = { theme: ShellTheme };
export const themeControl = {
  name: 'Thème',
  control: 'inline-radio',
  options: ['light', 'dark'],
} as const;

export function examplePages(): ShellPage[] {
  return [
    { id: 'projects', parentId: null, title: 'Projets', icon: '📁', section: 'workspace' },
    { id: 'design', parentId: 'projects', title: 'Navigation desktop', icon: '🎨', favorite: true },
    { id: 'shared', parentId: null, title: 'Idées de l’équipe', icon: '💡', section: 'Partagé' },
    { id: 'journal', parentId: null, title: 'Journal', icon: '📓', section: 'Privé' },
  ];
}

export function isolated(theme: ShellTheme, signal: AbortSignal, component: ReactNode) {
  const host = shellPreview(theme);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <div
        data-desktop-workspace=""
        data-blok-shell=""
        data-blok-interface="shell"
      >
        <aside
          data-blok-sidebar=""
          data-desktop-sidebar="tsx"
          aria-label="Composant de la barre latérale"
        >
          {component}
        </aside>
      </div>,
    ),
  );
  signal.addEventListener('abort', () => root.unmount(), { once: true });
  return host;
}
