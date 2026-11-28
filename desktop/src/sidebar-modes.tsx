import {shellText} from './shell-i18n';
import { useEffect, useRef } from 'react';
import { SidebarModeItem } from './sidebar-mode-item';
import './sidebar-modes.css';

export type SidebarMode = 'home' | 'chat' | 'calendar';

interface SidebarModesProps {
  onHome(): void;
  onChat?(): void;
  onCalendar?(): void;
  calendarHref?: string;
  active: SidebarMode;
}

export const SidebarModes = ({
  active,
  onHome,
  onChat,
  onCalendar,
  calendarHref,
}: SidebarModesProps) => {
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const doc = nav.ownerDocument;
    const shell = nav.closest('[data-blok-shell]') ?? nav;

    function selectByShortcut(event: KeyboardEvent) {
      if (
        !event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        event.defaultPrevented ||
        event.isComposing
      )
        return;
      // Sur un clavier AZERTY, la touche physique Digit2 peut produire « é ».
      const digit = /^Digit([123])$/.exec(event.code)?.[1] ?? event.key;
      if (!['1', '2', '3'].includes(digit) || !(event.target instanceof Element)) return;
      const target = event.target;
      if (
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]',
        )
      )
        return;
      if (!shell.isConnected) return;
      if (!shell.contains(target)) {
        if (target !== doc.body && target !== doc.documentElement) return;
        if (
          doc.querySelectorAll('[data-blok-sidebar-modes]').length !== 1 ||
          doc.querySelector('dialog[open], [aria-modal="true"]')
        )
          return;
      }
      const tab = navigation.current?.querySelector<HTMLElement>(
        `[aria-keyshortcuts="Control+${digit}"]`,
      );
      if (!tab) return;
      event.preventDefault();
      if (!event.repeat) tab.click();
    }
    doc.addEventListener('keydown', selectByShortcut);
    return () => doc.removeEventListener('keydown', selectByShortcut);
  }, []);
  return (
    <nav
      ref={navigation}
      data-blok-sidebar-modes="tsx"
      aria-label={shellText("Navigation de l’espace")}
    >
      <SidebarModeItem
        label={shellText("Accueil")}
        icon="home"
        shortcut={1}
        active={active === 'home'}
        onSelect={onHome}
      />
      {onChat && (
        <SidebarModeItem
          label={shellText("Discussions")}
          icon="chat"
          shortcut={2}
          active={active === 'chat'}
          onSelect={onChat}
        />
      )}
      {onCalendar && (
        <SidebarModeItem
          label={shellText("Calendrier")}
          icon="calendar"
          shortcut={3}
          active={active === 'calendar'}
          onSelect={onCalendar}
          href={calendarHref}
          data-blok-sidebar-calendar=""
        />
      )}
    </nav>
  );
};
