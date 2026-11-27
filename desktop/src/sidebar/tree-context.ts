import { createContext, useContext } from 'react';
import type { ShellPage } from '@blok/sidebar';
import type { SidebarOptions } from './sidebar-frame';

export interface TreeProps {
  options: SidebarOptions;
  pages: ShellPage[];
  pagesStatus?: 'loading' | 'error' | 'ready';
  activeId: string;
  recents: string[];
  query: string;
  visibility: { events: boolean; favorites: boolean };
  expanded: Map<string, boolean>;
  onExpand(id: string, open: boolean): void;
  onFavorite(id: string): void;
}
interface TreeState extends TreeProps {
  children: Map<string | null, ShellPage[]>;
  offline: Set<string>;
  toggleOffline(id: string): void;
  collapsed: Set<string>;
  toggleSection(key: string): void;
}
export const TreeContext = createContext<TreeState | null>(null);
export function useTree() {
  const tree = useContext(TreeContext);
  if (!tree) throw new Error('Sidebar tree components require a SidebarTree');
  return tree;
}
