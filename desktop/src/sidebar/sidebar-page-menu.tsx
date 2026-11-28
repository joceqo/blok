import {shellText} from '../shell-i18n';
import { SidebarIcon, type SidebarIconName } from './sidebar-icon';

import { DropdownMenuItem, DropdownMenuCheckboxItem } from '../components';
import { Fragment } from 'react';
import type { ShellPage, SidebarAction } from '@blok/sidebar';
import type { SidebarOptions } from './sidebar-frame';
import { SidebarMenu } from './sidebar-menu';

interface Props {
  page: ShellPage;
  options: SidebarOptions;
  offline: boolean;
  toggleOffline(): void;
  onFavorite(): void;
  onRename(): void;
}
interface Command {
  label: string;
  icon: SidebarIconName;
  action?: SidebarAction['type'];
  run(): void;
  checked?: boolean;
}
export const SidebarPageMenu = ({
  page,
  options,
  offline,
  toggleOffline,
  onFavorite,
  onRename,
}: Props) => {
  const action = (type: Exclude<SidebarAction['type'], 'rename' | 'offline'>) => () =>
    options.onAction?.({ id: page.id, type });
  function copyLink() {
    const fallback = new URL('/', location.origin);
    fallback.searchParams.set('page', page.id);
    void navigator.clipboard
      ?.writeText(options.pageUrl?.(page.id) ?? fallback.href)
      .catch(() => undefined);
  }
  const groups: Command[][] = [
    [
      {
        label: page.favorite ? shellText("Retirer des favoris") : shellText("Ajouter aux favoris"),
        icon: 'star',
        checked: !!page.favorite,
        run: onFavorite,
      },
      {
        label: shellText("Disponible hors connexion"),
        icon: 'cloud',
        action: 'offline',
        checked: offline,
        run: toggleOffline,
      },
    ],
    [
      { label: shellText("Copier le lien"), icon: 'link', run: copyLink },
      { label: shellText("Dupliquer"), icon: 'copy', action: 'duplicate', run: action('duplicate') },
      { label: shellText("Renommer"), icon: 'pencil', action: 'rename', run: onRename },
      { label: shellText("Déplacer vers"), icon: 'move', action: 'move', run: action('move') },
      { label: shellText("Mettre à la corbeille"), icon: 'trash', action: 'delete', run: action('delete') },
    ],
    [{ label: shellText("Transformer en wiki"), icon: 'wiki', action: 'wiki', run: action('wiki') }],
    [
      {
        label: shellText("Ouvrir dans un nouvel onglet"),
        icon: 'tab',
        action: 'open-tab',
        run: action('open-tab'),
      },
      {
        label: shellText("Ouvrir dans une nouvelle fenêtre"),
        icon: 'window',
        action: 'open-window',
        run: action('open-window'),
      },
      {
        label: shellText("Ouvrir en aperçu latéral"),
        icon: 'peek',
        action: 'open-peek',
        run: action('open-peek'),
      },
    ],
  ];
  const visible = groups
    .map((group) =>
      group.filter(
        ({ action }) =>
          !action ||
          ((!options.availableActions || options.availableActions.includes(action)) &&
            (action.startsWith('open-') || options.canEdit?.(page.id) !== false)),
      ),
    )
    .filter((group) => group.length);

  return (
    <SidebarMenu
      label={shellText("Actions de la page")}
      attributes={{ 'data-blok-sidebar-more': '' }}
      trigger={<SidebarIcon name="more" />}
    >
      {visible.map((group, index) => (
        <Fragment key={group[0].label}>
          {index > 0 && (
            <div
              data-blok-sidebar-menu-separator=""
              aria-hidden="true"
            />
          )}
          {group.map(({ label, icon, run, action, checked }) => {
            const content = (
              <>
                <span
                  data-blok-sidebar-menu-icon=""
                  aria-hidden="true"
                >
                  <SidebarIcon
                    name={icon}
                    filled={icon === 'star' && checked}
                  />
                </span>
                <span data-blok-sidebar-menu-label="">{label}</span>
                {action === 'offline' && (
                  <span
                    data-blok-sidebar-switch=""
                    aria-hidden="true"
                  />
                )}
              </>
            );
            if (checked !== undefined)
              return (
                <DropdownMenuCheckboxItem
                  key={label}
                  checked={checked}
                  render={<button type="button" />}
                  nativeButton
                  closeOnClick={action !== 'offline'}
                  data-filled={!action && checked ? '' : undefined}
                  onCheckedChange={run}
                >
                  {content}
                </DropdownMenuCheckboxItem>
              );
            return (
              <DropdownMenuItem
                key={label}
                nativeButton
                render={<button type="button" />}
                data-danger={action === 'delete' ? '' : undefined}
                onClick={run}
              >
                {content}
              </DropdownMenuItem>
            );
          })}
        </Fragment>
      ))}
      {!visible.at(-1)?.some((command) => command.action?.startsWith('open-')) && (
        <div
          data-blok-sidebar-menu-separator=""
          aria-hidden="true"
        />
      )}
    </SidebarMenu>
  );
};
