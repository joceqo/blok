import { cva } from 'class-variance-authority';
import type { MouseEvent } from 'react';
import { Button, Tooltip } from './components';
import { SidebarIcon, type SidebarIconName } from './sidebar/sidebar-icon';

const modeLabel = cva('sb:truncate', { variants: { visible: { false: 'sb:hidden' } } });

interface SidebarModeItemProps {
  label: string;
  icon: SidebarIconName;
  active: boolean;
  onSelect(): void;
  href?: string;
  showLabel?: boolean;
  shortcut?: number;
  'data-blok-sidebar-shortcut'?: string;
  'data-blok-sidebar-calendar'?: string;
}

export const SidebarModeItem = ({
  label,
  icon,
  active,
  onSelect,
  href,
  showLabel = active,
  shortcut,
  ...attributes
}: SidebarModeItemProps) => {
  const control = {
    ...attributes,
    'aria-label': label,
    'aria-current': active ? ('page' as const) : undefined,
    'aria-keyshortcuts': shortcut ? `Control+${shortcut}` : undefined,
    title: shortcut ? undefined : label,
  };
  const content = (
    <>
      <SidebarIcon name={icon} />
      <span className={modeLabel({ visible: showLabel })}>{label}</span>
    </>
  );
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onSelect();
  }
  const trigger = href ? (
    <a
      {...control}
      href={href}
      onClick={follow}
    >
      {content}
    </a>
  ) : (
    <Button
      variant="plain"
      {...control}
      type="button"
      onClick={onSelect}
    >
      {content}
    </Button>
  );
  if (!shortcut) return trigger;
  const modifier = /Mac/i.test(navigator.platform) ? '⌃' : 'Ctrl+';
  return (
    <Tooltip
      label={label}
      shortcut={`${modifier}${shortcut}`}
    >
      {trigger}
    </Tooltip>
  );
};
