import {shellText} from '../shell-i18n';
import type { ComponentProps } from 'react';
import type { SidebarMode } from '../sidebar-modes';
import { SidebarModes } from '../sidebar-modes';
import { SidebarModeItem } from '../sidebar-mode-item';
import { Button } from '../components';
import { SidebarIcon, type SidebarIconName } from './sidebar-icon';
import {
  NavigationGroup,
  navigationLabels,
  type NavigationId,
  type NavigationItem,
} from './navigation-layout';
import { NavigationItemMenu } from './navigation-item-menu';
import type { SidebarOptions } from './sidebar-frame';

const Shortcut = ({
  icon,
  label,
  onClick,
  ...attributes
}: {
  icon: SidebarIconName;
  label: string;
  onClick(): void;
} & Pick<ComponentProps<'button'>, 'hidden' | 'aria-haspopup'> & {
    'data-blok-sidebar-library'?: string;
  }) => {
  return (
    <Button
      variant="plain"
      {...attributes}
      type="button"
      data-blok-sidebar-shortcut=""
      onClick={onClick}
    >
      <SidebarIcon name={icon} />
      <span>{label}</span>
    </Button>
  );
};

export const SidebarShortcuts = ({
  options,
  mode,
  recents,
}: {
  options: SidebarOptions;
  mode: SidebarMode;
  recents: string[];
}) => {
  const items: NavigationItem[] = [];
  function add(id: NavigationId, icon: SidebarIconName, onClick: () => void) {
    const label = navigationLabels[id];
    items.push({
      id,
      content: (
        <div className="sidebar-shortcut-row">
          <Shortcut
            label={label}
            icon={icon}
            onClick={onClick}
            data-blok-sidebar-library={id === 'library' ? '' : undefined}
            aria-haspopup={id === 'teamsLink' ? 'dialog' : undefined}
          />
          <NavigationItemMenu
            id={id}
            label={label}
            kind="shortcut"
          />
        </div>
      ),
    });
  }
  if (options.canCreate?.(null) !== false) add('newPage', 'compose', () => options.onCreate(null));
  if (options.onNewChat) add('newChat', 'newChat', options.onNewChat);
  if (options.onLibrary) add('library', 'library', () => options.onLibrary?.([...recents]));
  if (options.onTeamspaces && options.hasTeamspaces) add('teamsLink', 'teams', options.onTeamspaces);
  return (
    <div data-blok-sidebar-shortcuts="">
      {options.onHome && (
        <SidebarModes
          active={mode}
          onHome={options.onHome}
          onChat={options.onChat}
          onCalendar={options.onCalendar}
          calendarHref={options.calendarHref}
        />
      )}
      <NavigationGroup items={items} />
      {!options.onHome && options.onCalendar && (
        <SidebarModeItem
          icon="calendar"
          label={shellText("Calendrier")}
          active={mode === 'calendar'}
          showLabel
          href={options.calendarHref}
          onSelect={options.onCalendar}
          data-blok-sidebar-shortcut=""
          data-blok-sidebar-calendar=""
        />
      )}
    </div>
  );
};
