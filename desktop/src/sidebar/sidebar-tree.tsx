import {shellText, shellLocale} from '../shell-i18n';
import type { ShellPage } from '@blok/sidebar';
import { useMemo, useState } from 'react';
import { Button, EmptyState, SectionAction } from '../components';
import { groupPages, withAncestors } from './page-hierarchy';
import { PageRow } from './page-row';
import { SidebarPageSkeleton } from './sidebar-page-skeleton';
import { SidebarIcon } from './sidebar-icon';
import { TreeContext, type TreeProps, useTree } from './tree-context';
import { NavigationGroup, navigationLabels, useNavigationLayout, type NavigationItem } from './navigation-layout';
import { UpcomingEvents } from './upcoming-events';
import type { LibraryView } from '../library-route';
import { sectionNames } from '../page-section';
import { Section, WorkspaceSection } from './tree-section';

const pageGroupViews = new Map<string, LibraryView>([
  [sectionNames.private, 'private'],
  [sectionNames.shared, 'shared'],
]);

const usePageSections = () => {
  const layout = useNavigationLayout();
  const entries: NavigationItem[] = [];
  const { options, pages, children, recents, query, visibility, collapsed, toggleSection } =
    useTree();
  const roots = children.get(null) ?? [];
  const groups = groupPages(roots, (page) => page.section ?? '');
  // Hors recherche, les sections vides donnent encore accès aux actions de création et d’invitation.
  if (!query) {
    if (options.teamspace && !groups.has('workspace')) groups.set('workspace', []);
    if (options.onInviteMembers && !groups.has('Partagé')) groups.set('Partagé', []);
    if (options.onCreatePrivate && !groups.has('Privé')) groups.set('Privé', []);
  }
  const order = ['workspace', 'Partagé', 'Privé'];
  function visiblePages(section: string, items: ShellPage[]) {
    if (query || !layout || !section) return items;
    const sort = layout.sort(section);
    const ordered = [...items];
    if (sort === 'title') ordered.sort((a, b) => a.title.localeCompare(b.title, shellLocale()));
    if (sort === 'edited') ordered.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return ordered.slice(0, layout.limit(section) || undefined);
  }
  const favorites = visiblePages(
    'favorites',
    pages.filter((p) => p.favorite),
  );
  const byId = new Map(pages.map((p) => [p.id, p]));
  const recent = recents
    .flatMap((id) => byId.get(id) ?? [])
    .slice(0, (layout?.limit('recents') ?? 5) || undefined);
  const createPrivate = options.onCreatePrivate && options.canCreate?.(null) !== false;
  if (!query && !options.onLibrary && recent.length)
    entries.push({
      id: 'recents',
      content: (
        <Section
          name="recents"
          libraryView="recents"
          label={shellText("Récents")}
        >
          {recent.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              shortcut
            />
          ))}
          {options.onSearch && (
            <Button
              variant="plain"
              type="button"
              data-blok-sidebar-shortcut=""
              onClick={() => options.onSearch?.([...recents])}
            >
              <SidebarIcon name="more" />
              {shellText("Tout voir")}
            </Button>
          )}
        </Section>
      ),
    });
  if (!query && visibility.favorites && favorites.length)
    entries.push({
      id: 'favorites',
      content: (
        <Section
          name="favorites"
          libraryView="favorites"
          label={shellText("Favoris")}
        >
          {favorites.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              shortcut
            />
          ))}
        </Section>
      ),
    });
  for (const [key, group] of [...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))) {
    const rows = visiblePages(key, group).map((page) => (
      <PageRow
        key={page.id}
        page={page}
      />
    ));
    if (!key) {
      entries.push({ id: 'pages', content: rows });
      continue;
    }
    if (key === 'workspace' && options.teamspace) {
      entries.push({
        id: key,
        content: (
          <WorkspaceSection
            key={key}
            name={options.teamspace.name}
          >
            {rows}
          </WorkspaceSection>
        ),
      });
      continue;
    }
    entries.push({
      id: key,
      content: (
        <Section
          key={key}
          name={key}
          label={key === 'Privé' || key === 'Partagé' ? navigationLabels[key] : key}
          libraryView={pageGroupViews.get(key)}
          action={
            key === 'Privé' &&
            createPrivate && (
              <SectionAction
                label={shellText("Créer une page privée")}
                tooltip={shellText("Ajouter une page")}
                onClick={() => {
                  if (collapsed.has(key)) toggleSection(key);
                  options.onCreatePrivate?.();
                }}
              >
                <SidebarIcon name="plus" />
              </SectionAction>
            )
          }
        >
          {rows}
          {key === 'Partagé' && !group.length && options.onInviteMembers && (
            <Button
              variant="plain"
              type="button"
              data-blok-sidebar-shortcut=""
              onClick={options.onInviteMembers}
            >
              <SidebarIcon name="plus" />
              {shellText("Inviter des membres")}
            </Button>
          )}
          {key === 'Privé' && !query && createPrivate && (
            <Button
              variant="plain"
              type="button"
              data-blok-sidebar-shortcut=""
              data-blok-sidebar-private-add-row=""
              onClick={options.onCreatePrivate}
            >
              <SidebarIcon name="plus" />
              {shellText("Ajouter une page")}
            </Button>
          )}
        </Section>
      ),
    });
  }
  return entries;
};

const Sections = () => {
  const { options, pagesStatus, query, visibility } = useTree();
  const pageEntries = usePageSections();
  const { children } = useTree();
  const entries: NavigationItem[] = [];
  if (!query && visibility.events && options.onHome && options.onCalendar)
    entries.push({
      id: 'events',
      content: (
        <Section
          name="events"
          label={shellText("Événements à venir")}
        >
          <UpcomingEvents
            load={options.upcomingEvents}
            connect={options.onConnectCalendar}
            open={options.onCalendar}
          />
        </Section>
      ),
    });
  const ready = pagesStatus !== 'loading' && pagesStatus !== 'error';
  if (ready) entries.push(...pageEntries);
  return (
    <>
      <NavigationGroup items={entries} />
      {ready && !children.get(null)?.length && (
        <EmptyState data-blok-sidebar-empty="">{shellText("Aucune page")}</EmptyState>
      )}
      {pagesStatus === 'loading' && <SidebarPageSkeleton teamspace={options.teamspace?.name} />}
      {pagesStatus === 'error' && (
        <p
          role="alert"
          data-blok-sidebar-empty=""
        >
          {shellText("Impossible de charger les pages.")}
        </p>
      )}
    </>
  );
};

function toggled(set: Set<string>, key: string) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export const SidebarTree = (props: TreeProps) => {
  const [offline, setOffline] = useState(new Set<string>());
  const [collapsed, setCollapsed] = useState(new Set<string>());
  // Include the ancestors of search matches so nested results remain reachable.
  const children = useMemo(() => {
    if (!props.query) return groupPages(props.pages, (page) => page.parentId);
    const matches = props.pages.filter((page) =>
      page.title.toLocaleLowerCase().includes(props.query),
    );
    const visible = withAncestors(
      matches.map((page) => page.id),
      props.pages,
    );
    return groupPages(
      props.pages.filter((page) => visible.has(page.id)),
      (page) => page.parentId,
    );
  }, [props.pages, props.query]);
  return (
    <nav
      data-blok-sidebar-tree=""
      aria-label={shellText("Pages")}
      aria-busy={props.pagesStatus === 'loading' || undefined}
    >
      <TreeContext.Provider
        value={{
          ...props,
          children,
          offline,
          collapsed,
          toggleSection: (key) => setCollapsed((previous) => toggled(previous, key)),
          toggleOffline: (id) => {
            props.options.onAction?.({ type: 'offline', id, on: !offline.has(id) });
            setOffline(toggled(offline, id));
          },
        }}
      >
        <Sections />
      </TreeContext.Provider>
    </nav>
  );
};
