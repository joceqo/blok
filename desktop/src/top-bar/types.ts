export interface PageBreadcrumbItem {
  id: string;
  title: string;
  icon?: string;
  onOpen?: () => void;
  menuHeading?: string;
  menu?: PageBreadcrumbChoice[];
}

export interface PageBreadcrumbChoice {
  id: string;
  title: string;
  icon?: string;
  current?: boolean;
  children?: PageBreadcrumbChoice[];
  onOpen: () => void;
}

export interface PageToolbar {
  element: HTMLElement;
  setBreadcrumbs(items: PageBreadcrumbItem[]): void;
  setTitle(title: string): void;
  setIcon(icon: string | undefined): void;
  setFavorite(favorite: boolean): void;
  setPeers(names: string[]): void;
  closeHistory(): void;
  destroy(): void;
}

export interface PageToolbarOptions {
  viewControls?: HTMLElement;
  /** La page vit sur le disque de cet appareil, pas sur un serveur. */
  storedOnDevice?: boolean;
  pageUrl?: (id: string) => string;
  favorite?: boolean;
  onFavorite?: (favorite: boolean) => void;
  readOnly?: boolean;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onHistory?: () => () => void;
}
