import {shellText} from '../shell-i18n';
import { DestinationIcon, FooterIcon } from './footer-icon';
import { createRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components';
import { WorkspaceChoices, type FooterChoices } from './workspace-choices';

export type { FooterChoices } from './workspace-choices';

interface FooterAction {
  name: string;
  title: string;
  isDisabled?: boolean;
  onActivate(): void;
}

interface FooterProps {
  choices: FooterChoices;
  name: string;
  context: string;
  host: HTMLElement;
  onSettings(panel: 'account' | 'preferences'): void;
  canCreate(): Promise<boolean>;
  helpItems(): FooterAction[];
  destinations(): FooterAction[];
}

interface FooterHandle {
  focus(): void;
  close(): void;
}

const actions = {
  help: { label: shellText("Aide et raccourcis"), icon: 'help' },
  destinations: { label: shellText("Autres vues de l’espace"), icon: 'apps' },
} as const;
type FooterMenu = 'workspace' | keyof typeof actions;

const FooterActions = ({ items, withIcons }: { items: FooterAction[]; withIcons: boolean }) => (
  <>
    {items.map((item) => (
      <DropdownMenuItem
        key={item.name}
        disabled={item.isDisabled}
        onClick={item.onActivate}
        data-desktop-menu-item=""
        data-blok-popover-item=""
        data-blok-item-name={item.name}
      >
        {withIcons && (
          <span data-blok-popover-item-icon="">
            <DestinationIcon name={item.name} />
          </span>
        )}
        <span data-blok-popover-item-title="">{item.title}</span>
      </DropdownMenuItem>
    ))}
  </>
);

const WorkspaceMenu = ({ choices, name, context, onSettings, canCreate }: FooterProps) => {
  const [allowCreation, setAllowCreation] = useState(false);
  useEffect(() => {
    const lifetime = new AbortController();
    void canCreate()
      .then((allowed) => {
        if (!lifetime.signal.aborted) setAllowCreation(allowed);
      })
      .catch(() => {});
    return () => {
      lifetime.abort();
    };
  }, [canCreate]);
  return (
    <>
      <DropdownMenuItem
        data-desktop-menu-account=""
        onClick={() => onSettings('account')}
      >
        <Avatar
          data-desktop-menu-avatar=""
          name={name}
        />
        <span data-desktop-menu-account-text="">
          <strong data-desktop-menu-title="">{name}</strong>
          <small data-desktop-menu-context="">{context}</small>
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem
        data-desktop-menu-item=""
        data-desktop-menu-preferences=""
        onClick={() => onSettings('preferences')}
      >
        <FooterIcon name="settings" /> {shellText("Paramètres")} </DropdownMenuItem>
      <WorkspaceChoices
        choices={choices}
        allowCreation={allowCreation}
      />
    </>
  );
};

export const SidebarFooter = ({ ref, ...props }: FooterProps & { ref?: Ref<FooterHandle> }) => {
  const [active, setActive] = useState<FooterMenu | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => trigger.current?.focus(),
    close: () => setActive(null),
  }));
  const container =
    props.host.closest<HTMLElement>('[data-blok-shell], [data-desktop-shell]') ?? props.host;
  const workspaceLabel =
    props.choices.current.kind === 'remote' ? 'Espaces et réglages' : 'Espace local et réglages';
  const menuProps = (menu: FooterMenu) => ({
    modal: false,
    open: active === menu,
    onOpenChange(open: boolean) {
      if (open) setActive(menu);
      else setActive((current) => (current === menu ? null : current));
    },
  });
  // Quand une action ouvre les réglages, le dialogue prend le focus à la fermeture du menu.
  const restoreFocus = () => !document.activeElement?.closest('[role="dialog"]');
  return (
    <>
      <DropdownMenu {...menuProps('workspace')}>
        <DropdownMenuTrigger
          ref={trigger}
          data-desktop-switcher=""
          aria-label={workspaceLabel}
        >
          <Avatar
            data-desktop-avatar=""
            name={props.name}
          />
          <span data-desktop-switcher-name="">{props.name}</span>
          <FooterIcon name="chevron" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          container={container}
          side="top"
          anchor={props.host}
          alignOffset={8}
          sideOffset={-5}
          align="start"
          data-desktop-footer-menu=""
          finalFocus={restoreFocus}
          aria-label={workspaceLabel}
        >
          <WorkspaceMenu {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
      {(['help', 'destinations'] as const).map((kind) => {
        const { label, icon } = actions[kind];
        const isHelp = kind === 'help';
        return (
          <DropdownMenu
            key={kind}
            {...menuProps(kind)}
          >
            <DropdownMenuTrigger
              title={label}
              aria-label={label}
              data-desktop-footer-action={kind}
            >
              <FooterIcon name={icon} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              container={container}
              side="top"
              align="start"
              sideOffset={8}
              alignOffset={isHelp ? 0 : -8}
              aria-label={label}
              finalFocus={restoreFocus}
              {...(isHelp
                ? { 'data-desktop-help-popover': '' }
                : { 'data-desktop-destinations-popover': '' })}
            >
              <FooterActions
                withIcons={!isHelp}
                items={isHelp ? props.helpItems() : props.destinations()}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </>
  );
};

export function mountFooterSurface(host: HTMLElement, props: Omit<FooterProps, 'host'>) {
  const root = createRoot(host);
  const ref = createRef<FooterHandle>();
  function render(name: string) {
    root.render(
      <SidebarFooter
        {...props}
        ref={ref}
        name={name}
        host={host}
      />,
    );
  }
  render(props.name);
  return {
    rename: render,
    focus: () => ref.current?.focus(),
    close: () => ref.current?.close(),
    destroy: () => root.unmount(),
  };
}
