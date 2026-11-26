import type { PageTarget, PageView } from './page-link';
import type { ShellPage } from '@blok/sidebar';

type Page = ShellPage & { cover?: string };
type Chat = { id: string; title: string; excerpt: string };
export type ContentMatch = { id: string; excerpt?: string };
export interface SearchOptions {
  workspaceName: string;
  pages(): Page[];
  onOpen(id: string, view?: PageView): void;
  recentIds?: string[];
  recentOnly?: boolean;
  visitedAt?(id: string): number | undefined;
  pageLinkFromUrl?(value: string): PageTarget | undefined;
  preview?(id: string, signal: AbortSignal): Promise<string>;
  searchContent?(query: string, signal: AbortSignal): Promise<ContentMatch[]>;
  onOpenTab?(id: string, view?: PageView): void;
  pageUrl?(id: string, view?: PageView): string;
  chats?(): Chat[];
  onOpenChat?(id: string): void;
}

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim();
}
function parents(page: Page, index: Map<string, Page>): Page[] {
  const ancestors: Page[] = [],
    seen = new Set([page.id]);
  for (
    let parent = index.get(page.parentId ?? '');
    parent && !seen.has(parent.id);
    parent = index.get(parent.parentId ?? '')
  ) {
    seen.add(parent.id);
    ancestors.unshift(parent);
  }
  return ancestors;
}
function recentGroup(when: number | undefined): string {
  if (!when) return 'Récemment consultées';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(when);
  day.setHours(0, 0, 0, 0);
  const age = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (age <= 0) return 'Aujourd’hui';
  if (age === 1) return 'Hier';
  if (age < 7) return 'Ces 7 derniers jours';
  if (age < 30) return 'Ces 30 derniers jours';
  return 'Plus ancien';
}
export type Result = { id: string; title: string; path: string; group: string; excerpt?: string; page?: Page; view?: PageView };

export function searchGroups(options: SearchOptions, mode: 'pages' | 'chats', input: string, scope: string, hits: Map<string,string>) {
  const query = normalize(input);
  const groups = new Map<string, Result[]>();
  if (mode === 'chats') {
    const chats = (options.chats?.() ?? []).filter(chat => normalize(chat.title + ' ' + chat.excerpt).includes(query));
    if (chats.length) groups.set('Conversations', chats.map(chat => ({...chat, group:'Conversations', path:options.workspaceName})));
    return groups;
  }
  const pages = options.pages();
  const index = new Map(pages.map(page => [page.id, page]));
  const recent = new Map((options.recentIds ?? []).map((id, i) => [id, i]));
  const link = options.pageLinkFromUrl?.(input.trim());
  const results: (Result & {score: number; visit: number; rank: number})[] = [];
  for (const page of pages) {
    const name = page.title || 'Nouvelle page';
    const title = normalize(name);
    if (link ? page.id !== link.id : !title.includes(query) && !hits.has(page.id)) continue;
    if (!query && options.recentOnly && !recent.has(page.id)) continue;
    const chain = parents(page, index);
    if (scope && page.id !== scope && !chain.some(parent => parent.id === scope)) continue;
    const visit = options.visitedAt?.(page.id);
    const group = query ? 'Résultats' : recent.has(page.id) ? recentGroup(visit) : 'Pages de l’espace';
    const score = !query || title === query ? 0 : title.startsWith(query) ? 1 : title.includes(query) ? 2 : 3;
    results.push({id:page.id, title:name, page, group, ...(link && {view:link.view ?? 'document'}), path:[options.workspaceName, ...chain.map(p => p.title || 'Nouvelle page')].join(' / '),
      excerpt:hits.get(page.id), score, visit:visit ?? 0, rank:recent.get(page.id) ?? Number.MAX_SAFE_INTEGER});
  }
  results.sort((a,b) => a.score - b.score || b.visit - a.visit || a.rank - b.rank);
  for (const result of results) {
    const group = groups.get(result.group);
    if (group) group.push(result);
    else groups.set(result.group, [result]);
  }
  return groups;
}
