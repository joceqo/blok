import { createContext, useContext, useState, type Ref, type ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, Tooltip } from '../components';

export const SidebarMenuRevision = createContext(0);

interface SidebarMenuProps {
  label: string;
  trigger: ReactNode;
  attributes: { [key: `data-${string}`]: string };
  children: ReactNode;
  triggerRef?: Ref<HTMLButtonElement>;
  placement?: 'page' | 'preferences' | 'actions' | 'navigation';
}

export const SidebarMenu = ({
  label,
  trigger,
  attributes,
  triggerRef,
  children,
  placement = 'page',
}: SidebarMenuProps) => {
  const revision = useContext(SidebarMenuRevision);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const button = (
    <DropdownMenuTrigger
      {...attributes}
      ref={triggerRef}
      title={placement === 'navigation' ? undefined : label}
      aria-label={label}
    >
      {trigger}
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu
      modal={false}
      open={openedAt === revision}
      onOpenChange={(open, event) => {
        if (open) setHost(event.trigger?.closest<HTMLElement>('[data-blok-shell]') ?? null);
        setOpenedAt(open ? revision : null);
      }}
    >
      {placement === 'navigation' ? <Tooltip label={label}>{button}</Tooltip> : button}
      <DropdownMenuContent
        data-blok-sidebar-menu=""
        aria-label={label}
        data-sidebar-navigation-menu={placement === 'navigation' ? '' : undefined}
        data-sidebar-preferences-menu={
          placement === 'preferences' || placement === 'actions' ? '' : undefined
        }
        side={placement === 'preferences' ? 'top' : 'bottom'}
        align={placement === 'page' ? 'end' : 'start'}
        sideOffset={{ navigation: 2, page: 4, preferences: 8, actions: 8 }[placement]}
        collisionPadding={8}
        collisionAvoidance={{ align: 'shift', side: 'flip' }}
        container={host}
        finalFocus={() => !document.activeElement?.matches('input, textarea, [role="dialog"]')}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
