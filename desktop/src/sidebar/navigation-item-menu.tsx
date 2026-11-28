import {shellText} from '../shell-i18n';
import { useContext, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CornerUpRight,
  Hash,
  ChevronRight,
  SlidersHorizontal,
  X,
  Check,
} from 'lucide-react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
} from '../components';
import {
  NavigationSiblings,
  pageSortLabels,
  tabLabels,
  useNavigationLayout,
} from './navigation-layout';
import { SidebarIcon } from './sidebar-icon';
import { SidebarPreferenceItems } from './sidebar-customize-menu';
import { SidebarMenu } from './sidebar-menu';

const Submenu = ({
  label,
  icon,
  hint,
  children,
}: {
  label: string;
  icon: ReactNode;
  hint?: string;
  children: ReactNode;
}) => {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <DropdownMenuSubmenu
      onOpenChange={(open, event) => {
        if (open) setHost(event.trigger?.closest<HTMLElement>('[data-blok-shell]') ?? null);
      }}
    >
      <DropdownMenuSubmenuTrigger>
        {icon}
        <span>{label}</span>
        <small>{hint}</small>
        <ChevronRight size={14} />
      </DropdownMenuSubmenuTrigger>
      <DropdownMenuContent
        container={host}
        side="right"
        sideOffset={4}
        data-sidebar-navigation-menu=""
        aria-label={label}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenuSubmenu>
  );
};

export const NavigationItemMenu = ({
  id,
  label,
  kind,
}: {
  id: string;
  label: string;
  kind: 'shortcut' | 'section';
}) => {
  const layout = useNavigationLayout();
  const siblings = useContext(NavigationSiblings);
  if (!layout?.options.preferenceKey || !siblings.includes(id)) return null;
  const index = siblings.indexOf(id);
  const limit = layout.limit(id);
  const refocus = () => requestAnimationFrame(() => layout.customizeButton.current?.focus());
  return (
    <SidebarMenu
      placement="navigation"
      label={shellText("Options de {v0}", {v0: label})}
      attributes={{ 'data-sidebar-nav-more': '' }}
      trigger={<SidebarIcon name="more" />}
    >
      {kind === 'section' && (
        <>
          {id !== 'events' && id !== 'recents' && (
            <Submenu
              label={shellText("Trier")}
              icon={<ArrowDownUp />}
              hint={pageSortLabels[layout.sort(id)]}
            >
              {(['edited', 'title', 'manual'] as const).map((sort) => (
                <DropdownMenuItem
                  key={sort}
                  onClick={() => layout.place(id, { sort })}
                >
                  {pageSortLabels[sort]}
                  {sort === layout.sort(id) && <Check />}
                </DropdownMenuItem>
              ))}
            </Submenu>
          )}
          <Submenu
            label={shellText("Afficher")}
            hint={limit ? String(limit) : shellText("Tout")}
            icon={<Hash />}
          >
            {[5, 10, 20, 0].map((count) => (
              <DropdownMenuItem
                key={count}
                onClick={() => layout.place(id, { limit: count })}
              >
                {count ? String(count) : shellText("Tout afficher")}
                {limit === count && <Check />}
              </DropdownMenuItem>
            ))}
          </Submenu>
          <div data-blok-sidebar-menu-separator="" />
        </>
      )}
      {index > 0 && (
        <DropdownMenuItem onClick={() => layout.move(siblings, id, -1)}>
          <ArrowUp />
          {shellText("Monter")}
        </DropdownMenuItem>
      )}
      {index + 1 < siblings.length && (
        <DropdownMenuItem onClick={() => layout.move(siblings, id, 1)}>
          <ArrowDown />
          {shellText("Descendre")}
        </DropdownMenuItem>
      )}
      {layout.tabs.length > 1 && (
        <Submenu
          label={shellText("Déplacer vers un onglet")}
          icon={<CornerUpRight />}
        >
          {layout.tabs
            .filter((tab) => tab !== layout.mode)
            .map((tab) => (
              <DropdownMenuItem
                key={tab}
                onClick={() => {
                  layout.place(id, { tab, hiddenIn: [] });
                  refocus();
                }}
              >
                {tabLabels[tab]}
              </DropdownMenuItem>
            ))}
        </Submenu>
      )}
      <DropdownMenuItem
        onClick={() => {
          layout.show(id, false);
          refocus();
        }}
      >
        <X />
        {kind === 'section' ? shellText("Retirer la section") : shellText("Retirer le raccourci")}
      </DropdownMenuItem>
      <div data-blok-sidebar-menu-separator="" />
      {!layout.prefs.getSnapshot().customize ? (
        <Submenu
          label={shellText("Personnaliser la barre latérale")}
          icon={<SlidersHorizontal />}
        >
          <SidebarPreferenceItems
            prefs={layout.prefs}
            pages={layout.pages}
          />
        </Submenu>
      ) : (
        <DropdownMenuItem onClick={layout.customize}>
          <SlidersHorizontal />
          {shellText("Personnaliser la barre latérale")}
        </DropdownMenuItem>
      )}
    </SidebarMenu>
  );
};
