import {shellText} from './shell-i18n';
import { nativePageLink, pageView } from './page-link';

/**
 * The tab strip's own context menu.
 *
 * Without one, a right-click on a tab fell through to WKWebView's default menu,
 * which offers "Reload" and nothing else — none of the tab actions a person
 * expects from Notion or a browser.
 */

export type TabMenuAction =
  | 'copy-link'
  | 'reload'
  | 'duplicate'
  | 'close'
  | 'close-others'
  | 'close-left'
  | 'close-right';

export interface TabMenuItem {
  action: TabMenuAction;
  label: string;
  disabled: boolean;
  /** Starts a new group in the rendered menu. */
  separated?: boolean;
}

export interface TabMenuContext {
  tabId: string;
  tabIds: string[];
  href: string;
}

/**
 * The link to copy for a tab, or null when it shows no page.
 *
 * `blok_open` takes a document id, and a tab's href carries it as `?page=<id>`,
 * so the id is handed over verbatim: an agent given this link can open the very
 * page the tab shows.
 */
export function pageLinkFor(href: string): string | null {
  try {
    const url = new URL(href, 'http://localhost');
    const id = url.searchParams.get('page');
    if (!id) return null;
    const disk = url.searchParams.get('local') === '1' ? url.searchParams.get('workspace') : undefined;
    return nativePageLink(id, pageView(url), disk ?? undefined);
  } catch {
    return null;
  }
}

export function buildTabMenuItems(context: TabMenuContext): TabMenuItem[] {
  const index = context.tabIds.indexOf(context.tabId);
  const alone = context.tabIds.length <= 1;
  return [
    { action: 'copy-link', label: shellText("Copier le lien"), disabled: pageLinkFor(context.href) === null },
    { action: 'reload', label: shellText("Recharger l’onglet"), disabled: false },
    { action: 'duplicate', label: shellText("Dupliquer l’onglet"), disabled: false, separated: true },
    { action: 'close', label: shellText("Fermer l’onglet"), disabled: alone, separated: true },
    { action: 'close-others', label: shellText("Fermer les autres onglets"), disabled: alone },
    { action: 'close-left', label: shellText("Fermer les onglets à gauche"), disabled: index <= 0 },
    { action: 'close-right', label: shellText("Fermer les onglets à droite"), disabled: index < 0 || index >= context.tabIds.length - 1 },
  ];
}
