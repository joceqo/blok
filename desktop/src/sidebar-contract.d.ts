export interface ShellPage {
  updatedAt?: number;
  id: string;
  title: string;
  icon?: string;
  parentId: string | null;
  favorite?: boolean;
  /** Titre de section, dérivé de l'état de partage par l'hôte. */
  section?: string;
}
export type SidebarAction =
  | { id: string; type: 'rename'; title: string }
  | { id: string; type: 'duplicate' | 'delete' | 'move' | 'wiki' | 'open-tab' | 'open-window' | 'open-peek' }
  | { id: string; type: 'offline'; on: boolean };
export interface PageFrame {
  sidebarPreferences: import('../../src/shell/sidebar-preferences').SidebarPreferences;
  element: HTMLElement;
  canvas: HTMLElement;
  headerActions: HTMLElement;
  setPages(pages: ShellPage[], activeId: string): void;
  setCalendarActive(active: boolean): void;
  setChatActive(active: boolean): void;
  toggleSidebar(): void;
}
export function createPageFrame(options: {
  pages: ShellPage[];
  collapsedByDefault?: boolean;
  activeId: string;
  /** L'espace courant, rendu comme une ligne sous « Espaces » plutôt qu'un titre. */
  teamspace?: { name: string };
  /** Vrai quand au moins un espace d'équipe existe, pas quand l'espace est distant. */
  hasTeamspaces?: boolean;
  onOpen(id: string): void;
  onCreate(parentId: string | null): void;
  onAction?(action: SidebarAction): void;
  onFavorite?(id: string, favorite: boolean): void;
  onCreatePrivate?(): void;
  onSearch?(recentIds?: string[]): void;
  recentIds?: string[];
  onRecentsChange?(ids: string[]): void;
  preferenceKey?: string;
  onInviteMembers?(): void;
  onHome?(): void;
  onChat?(): void;
  onNewChat?(): void;
  /** The conversations held with the assistant, for the sidebar's chat tab */
  chats?(): readonly { id: string; title: string; excerpt: string }[];
  onOpenChat?(id: string): void;
  onLibrary?(recentIds: string[]): void;
  onCalendar?(): void;
  calendarHref?: string;
  onTeamspaces?(): void;
  onTeamspaceMenu?(anchor: HTMLButtonElement): void;
  pageUrl?(id: string): string;
  availableActions?: SidebarAction['type'][];
  canEdit?(id: string): boolean;
  canCreate?(parentId: string | null): boolean;
}): PageFrame;
