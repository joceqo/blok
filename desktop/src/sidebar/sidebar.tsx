import {shellText} from '../shell-i18n';
import { NavigationLayout } from './navigation-layout';
import { SidebarSuggestions } from './sidebar-suggestions';
import { SidebarPreferencesMenu } from './sidebar-customize-menu';
import { SidebarShortcuts } from './sidebar-shortcuts';
import { SidebarIcon } from './sidebar-icon';
import { Button, SearchField } from '../components';
export { SidebarPreferencesMenu, SidebarShortcuts };
import { useId, useState, useSyncExternalStore, type ComponentProps, type Ref } from 'react';
import type { SidebarPreferences } from '../../../src/shell/sidebar-preferences';
import type { SidebarMode } from '../sidebar-modes';
import { SidebarChats } from './sidebar-chats';
import { SidebarTree } from './sidebar-tree';
import { SidebarResize } from './sidebar-resize';
import type { SidebarOptions } from './sidebar-frame';

interface Props extends Omit<ComponentProps<typeof SidebarTree>, 'query' | 'visibility'> {
  mode: SidebarMode;
  prefs: SidebarPreferences;
  collapsed: boolean;
  toggleSidebar(): void;
  headerActions: Ref<HTMLDivElement>;
}

export const SidebarHeader = ({
  options,
  headerActions,
  toggleSidebar,
}: Pick<Props, 'options' | 'headerActions' | 'toggleSidebar'>) => {
  return (
    <div data-blok-sidebar-header="">
      <Button
        variant="plain"
        type="button"
        data-blok-sidebar-icon=""
        aria-label={shellText("Masquer la barre latérale")}
        title={shellText("Masquer la barre latérale")}
        onClick={toggleSidebar}
      >
        <SidebarIcon name="collapse" />
      </Button>
      <div
        data-blok-sidebar-header-actions=""
        ref={headerActions}
      >
        <Button
          variant="plain"
          type="button"
          data-blok-sidebar-icon=""
          aria-label={shellText("Nouvelle page")}
          title={shellText("Nouvelle page")}
          hidden={options.canCreate?.(null) === false}
          onClick={() => options.onCreate(null)}
        >
          <SidebarIcon name="compose" />
        </Button>
      </div>
    </div>
  );
};

interface SidebarSearchProps {
  onSearch: SidebarOptions['onSearch'];
  onFilter(value: string): void;
}

export const SidebarSearch = ({ onSearch, onFilter }: SidebarSearchProps) => {
  const fieldId = useId();
  if (onSearch)
    return (
      <Button
        variant="plain"
        type="button"
        data-blok-sidebar-search=""
        aria-label={shellText("Rechercher une page")}
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+P Control+P Meta+K Control+K"
        onClick={() => onSearch()}
      >
        <span>{shellText("Rechercher…")}</span>
        <kbd>{/Mac/i.test(navigator.platform) ? '⌘K' : "Ctrl K"}</kbd>
      </Button>
    );
  return (
    <label
      htmlFor={fieldId}
      data-blok-sidebar-search=""
    >
      <SidebarIcon name="search" />
      <SearchField
        id={fieldId}
        appearance="inline"
        placeholder={shellText("Rechercher une page…")}
        aria-label={shellText("Rechercher une page")}
        onChange={(e) => onFilter(e.target.value.trim().toLocaleLowerCase())}
      />
    </label>
  );
};

export const Sidebar = ({
  options,
  mode,
  prefs,
  collapsed,
  toggleSidebar,
  headerActions,
  ...tree
}: Props) => {
  const [query, setQuery] = useState('');
  const [width, setWidth] = useState(270);
  const visibility = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot);
  return (
    <NavigationLayout
      mode={options.onHome ? mode : 'home'}
      options={options}
      prefs={prefs}
      pages={tree.pages}
    >
      <aside
        data-blok-sidebar=""
        data-blok-testid="sidebar"
        data-desktop-sidebar="tsx"
        data-collapsed={collapsed ? '' : undefined}
        style={{ width: collapsed ? 0 : width }}
      >
        <SidebarHeader
          options={options}
          headerActions={headerActions}
          toggleSidebar={toggleSidebar}
        />
        <SidebarSearch
          onSearch={options.onSearch}
          onFilter={setQuery}
        />
        <SidebarShortcuts
          options={options}
          mode={mode}
          recents={tree.recents}
        />
        {mode === 'chat' && options.chats ? (
          // The chat tab is a view of the workspace, not a section of the
          // tree: it stands in the tree's place rather than beside it.
          <SidebarChats
            chats={options.chats}
            onOpen={id => options.onOpenChat?.(id)}
            onNew={() => options.onNewChat?.()}
          />
        ) : (
          <SidebarTree
            {...tree}
            activeId={mode === 'calendar' ? '' : tree.activeId}
            options={options}
            query={query}
            visibility={visibility}
          />
        )}
        {options.preferenceKey && (
          <SidebarPreferencesMenu
            prefs={prefs}
            pages={tree.pages}
          />
        )}
        {options.preferenceKey && (
          <SidebarSuggestions
            prefs={prefs}
            options={options}
          />
        )}
        {/* The workspace mounts the account switcher and its settings controller here. */}
        <div data-desktop-footer="" />
        <SidebarResize
          width={width}
          collapsed={collapsed}
          onToggle={toggleSidebar}
          onWidth={(next) => {
            setWidth(next);
            if (collapsed) toggleSidebar();
          }}
        />
      </aside>
    </NavigationLayout>
  );
};
