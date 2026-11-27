import {useEffect, useRef, useState} from 'react';
import {shellText} from '../shell-i18n';
import {WORKSPACE_ROLES} from '../access-vocabulary';
import {DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from '../components';
import {Breadcrumbs} from './breadcrumbs';
import {Glyph} from './page-mark';
import type {PageBreadcrumbItem, PageToolbarOptions} from './types';

const SIDEBAR = ['M2 2.5h12v11H2z', 'M6 2.5v11'];
const LINK = ['M6.5 9.5 9.5 6.5', 'M6 10l-1 1a2.5 2.5 0 0 1-3.5-3.5L4 5', 'M10 6l1-1a2.5 2.5 0 0 1 3.5 3.5L12 11'];
const CHECK = ['M3.5 8.5 6.5 11.5 12.5 4.5'];
const STAR = ['M8 1.8 9.7 6.1l4.6.4-3.5 2.9 1.1 4.5L8 11.5 4.1 13.9l1.1-4.5L1.7 6.5l4.6-.4Z'];
const DOTS = ['M3 8h.2', 'M7.9 8h.2', 'M12.8 8h.2'];
const DEVICE = ['M2.5 3.5h11v8h-11z', 'M5.5 13.5h5'];

/** Un élément construit ailleurs — les bascules de vue — prêté à la barre. */
const Adopted = ({node}: {node: HTMLElement}) => {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.append(node);
    return () => node.remove();
  }, [node]);
  return <div ref={host}/>;
};

/** Le lien copié le dit sur le bouton lui-même, puis s'efface. */
const CopyLink = ({href}: {href?: string}) => {
  const [notice, setNotice] = useState('');
  useEffect(() => setNotice(''), [href]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function copy() {
    if (!href) return;
    try {
      await navigator.clipboard.writeText(href);
      setNotice(shellText("Lien copié"));
    } catch {
      setNotice(shellText("Copie impossible"));
    }
  }
  const copied = notice === shellText("Lien copié");
  return <>
    <button type="button" data-desktop-page-copy="" onClick={() => void copy()}
      aria-label={notice || shellText("Copier le lien de la page")}
      title={notice || shellText("Copier le lien de la page")}>
      <Glyph paths={copied ? CHECK : LINK}/>
    </button>
    <span data-desktop-page-feedback="" role="status" hidden={!notice}>{notice}</span>
  </>;
};

const Favorite = ({value, onChange}: {value: boolean; onChange(next: boolean): void}) => {
  const label = value ? shellText("Retirer des favoris") : shellText("Ajouter aux favoris");
  return <button type="button" data-desktop-page-favorite="" aria-pressed={value}
    aria-label={label} title={label} onClick={() => onChange(!value)}>
    <Glyph paths={STAR}/>
  </button>;
};

interface MenuProps extends Pick<PageToolbarOptions, 'readOnly' | 'storedOnDevice' | 'onRename' | 'onDuplicate' | 'onDelete' | 'onHistory'> {
  container: HTMLElement;
  fullWidth: boolean;
  onFullWidthChange(value: boolean): void;
  onHistoryOpen(close: () => void): void;
}

const PageMenu = ({container, fullWidth, onFullWidthChange, onHistoryOpen, ...options}: MenuProps) => {
  const commands = [
    [shellText("Renommer"), options.onRename, false],
    [shellText("Dupliquer"), options.onDuplicate, false],
    [shellText("Mettre à la corbeille"), options.onDelete, true],
  ] as const;

  return <DropdownMenu>
    <DropdownMenuTrigger render={<button type="button"/>} data-desktop-page-more="" aria-label={shellText("Actions de la page")}
      title={shellText("Actions de la page")}>
      <Glyph paths={DOTS}/>
    </DropdownMenuTrigger>
    <DropdownMenuContent data-desktop-page-menu="" container={container} align="end"
      aria-label={shellText("Apparence et mise en page")}>
      <div data-desktop-page-menu-heading="">{shellText("Apparence et mise en page")}</div>
      <DropdownMenuCheckboxItem render={<button type="button"/>} data-desktop-page-full-width=""
        closeOnClick={false} aria-label={shellText("Pleine largeur")}
        checked={fullWidth} disabled={options.readOnly === true}
        onCheckedChange={value => onFullWidthChange(value)}>
        <span>{shellText("Pleine largeur")}</span>
        <span data-desktop-page-switch-track=""/>
      </DropdownMenuCheckboxItem>
      {/* Où la page dort est une information de second plan : elle se
          consulte, elle ne s'impose pas dans la barre du haut. */}
      {options.storedOnDevice && <span data-desktop-page-local=""
        title={shellText("Cette page est enregistrée sur cet appareil")}>
        <Glyph paths={DEVICE}/>{shellText("Sur cet appareil")}
      </span>}
      {options.onHistory && <DropdownMenuItem render={<button type="button"/>} data-desktop-page-command=""
        onClick={() => { const close = options.onHistory?.(); if (close) onHistoryOpen(close); }}>
        {shellText("Historique des versions")}
      </DropdownMenuItem>}
      {commands.map(([title, run, danger]) => run && !options.readOnly
        ? <DropdownMenuItem render={<button type="button"/>} key={title} data-desktop-page-command="" {...(danger && {'data-danger': ''})}
            onClick={run}>{title}</DropdownMenuItem>
        : null)}
    </DropdownMenuContent>
  </DropdownMenu>;
};

export interface TopBarProps {
  items: PageBreadcrumbItem[];
  container: HTMLElement;
  fullWidth: boolean;
  favorite: boolean;
  peers: string[];
  onFullWidthChange(value: boolean): void;
  onToggleSidebar?: () => void;
  onShare?: (anchor: HTMLButtonElement) => (() => void) | void;
  onHistoryOpen(close: () => void): void;
  options: PageToolbarOptions;
}

export const TopBar = ({items, container, fullWidth, favorite, peers, onFullWidthChange, onToggleSidebar, onShare, onHistoryOpen, options}: TopBarProps) => {
  const share = useRef<HTMLButtonElement>(null);
  const [starred, setStarred] = useState(favorite);
  useEffect(() => setStarred(favorite), [favorite]);
  const current = items.at(-1);
  const label = peers.length ? 'Sur cette page · ' + peers.join(', ') : '';
  const shown = peers.length > 2 ? peers.slice(0, 2).join(', ') + ' +' + (peers.length - 2) : peers.join(', ');

  return <>
    {onToggleSidebar && <button type="button" data-desktop-sidebar-toggle=""
      aria-label={shellText("Afficher ou masquer la barre latérale")}
      title={shellText("Afficher ou masquer la barre latérale")} onClick={onToggleSidebar}>
      <Glyph paths={SIDEBAR}/>
    </button>}
    <div data-desktop-page-identity="">
      <Breadcrumbs items={items} container={container}/>
      {options.readOnly && <span data-desktop-page-readonly="">{WORKSPACE_ROLES.viewer}</span>}
    </div>
    <div data-desktop-page-actions="">
      {/* Les bascules de vue sont des actions, pas une partie du nom de la
          page : elles collaient au titre au lieu de tenir avec le reste. */}
      {options.viewControls && <Adopted node={options.viewControls}/>}
      {options.onHistory && <span data-desktop-page-peers="" hidden={!peers.length}
        title={label} aria-label={label}>{shown}</span>}
      {onShare && <button type="button" ref={share} data-desktop-page-share=""
        aria-haspopup="dialog" aria-expanded="false"
        onClick={() => { if (share.current) onShare(share.current); }}>{shellText("Partager")}</button>}
      <CopyLink href={current && options.pageUrl ? options.pageUrl(current.id) : undefined}/>
      {options.onFavorite && <Favorite value={starred}
        onChange={next => { setStarred(next); options.onFavorite?.(next); }}/>}
      <PageMenu container={container} fullWidth={fullWidth} onFullWidthChange={onFullWidthChange}
        onHistoryOpen={onHistoryOpen} readOnly={options.readOnly} storedOnDevice={options.storedOnDevice}
        onRename={options.onRename} onDuplicate={options.onDuplicate} onDelete={options.onDelete}
        onHistory={options.onHistory}/>
    </div>
  </>;
};
