import {useEffect, useRef, useState} from 'react';
import {shellText} from '../shell-i18n';
import {WORKSPACE_ROLES} from '../access-vocabulary';
import {DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from '../components';
import {Breadcrumbs} from './breadcrumbs';
import {DeviceGlyph, Glyph} from './page-mark';
import {IconDotsHorizontal, IconLink, IconSidebarRight, IconStarFilled} from '../../../src/components/icons';
import type {PageBreadcrumbItem, PageToolbarOptions} from './types';

// Les dessins viennent de la famille Blok Line, pas d'une copie locale.

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
  // Le dessin ne change pas : le bouton reste reconnaissable, c'est son
  // intitulé et le compte rendu à côté qui disent ce qui vient de se passer.
  return <>
    <button type="button" data-desktop-page-copy="" onClick={() => void copy()}
      aria-label={notice || shellText("Copier le lien de la page")}
      title={notice || shellText("Copier le lien de la page")}>
      <Glyph svg={IconLink}/>
    </button>
    <span data-desktop-page-feedback="" role="status" hidden={!notice}>{notice}</span>
  </>;
};

const Favorite = ({value, onChange}: {value: boolean; onChange(next: boolean): void}) => {
  const label = value ? shellText("Retirer des favoris") : shellText("Ajouter aux favoris");
  return <button type="button" data-desktop-page-favorite="" aria-pressed={value}
    aria-label={label} title={label} onClick={() => onChange(!value)}>
    <Glyph svg={IconStarFilled}/>
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

  // Non modal : un menu de barre d'outils n'a pas à bloquer la page, et le
  // verrou de défilement escamotait la barre de défilement — toute la barre
  // du haut sautait de quelques pixels à l'ouverture.
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger render={<button type="button"/>} data-desktop-page-more="" aria-label={shellText("Actions de la page")}
      title={shellText("Actions de la page")}>
      <Glyph svg={IconDotsHorizontal}/>
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
      {options.onHistory && <DropdownMenuItem render={<button type="button"/>} data-desktop-page-command=""
        onClick={() => { const close = options.onHistory?.(); if (close) onHistoryOpen(close); }}>
        {shellText("Historique des versions")}
      </DropdownMenuItem>}
      {commands.map(([title, run, danger]) => run && !options.readOnly
        ? <DropdownMenuItem render={<button type="button"/>} key={title} data-desktop-page-command="" {...(danger && {'data-danger': ''})}
            onClick={run}>{title}</DropdownMenuItem>
        : null)}
      {/* En bas, derrière un trait : ce n'est pas une action, c'est un état.
          Où la page dort se consulte, ça ne s'impose pas dans la barre. */}
      {options.storedOnDevice && <span data-desktop-page-local=""
        title={shellText("Cette page est enregistrée sur cet appareil")}>
        <DeviceGlyph/>{shellText("Sur cet appareil")}
      </span>}
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
  // Les surfaces sortent au niveau de la coquille : la barre est « sticky »
  // avec son propre z-index, donc un menu posé dedans ne peut pas passer
  // au-dessus de ce qui la suit. La coquille porte aussi le thème, que le
  // corps de la page ne donnerait pas.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(container.closest<HTMLElement>('[data-desktop-shell]') ?? container), [container]);
  const surface = host ?? container;
  const [starred, setStarred] = useState(favorite);
  useEffect(() => setStarred(favorite), [favorite]);
  const current = items.at(-1);
  const label = peers.length ? 'Sur cette page · ' + peers.join(', ') : '';
  const shown = peers.length > 2 ? peers.slice(0, 2).join(', ') + ' +' + (peers.length - 2) : peers.join(', ');

  return <>
    {onToggleSidebar && <button type="button" data-desktop-sidebar-toggle=""
      aria-label={shellText("Afficher ou masquer la barre latérale")}
      title={shellText("Afficher ou masquer la barre latérale")} onClick={onToggleSidebar}>
      <Glyph svg={IconSidebarRight}/>
    </button>}
    <div data-desktop-page-identity="">
      <Breadcrumbs items={items} container={surface}/>
      {/* Les bascules de vue appartiennent à la page : elles se tiennent
          contre son nom. Elles paraissaient mal placées tant que le fil
          s'étirait sur toute la barre et les emportait au loin. */}
      {options.viewControls && <Adopted node={options.viewControls}/>}
      {options.readOnly && <span data-desktop-page-readonly="">{WORKSPACE_ROLES.viewer}</span>}
    </div>
    <div data-desktop-page-actions="">
      {options.onHistory && <span data-desktop-page-peers="" hidden={!peers.length}
        title={label} aria-label={label}>{shown}</span>}
      {onShare && <button type="button" ref={share} data-desktop-page-share=""
        aria-haspopup="dialog" aria-expanded="false"
        onClick={() => { if (share.current) onShare(share.current); }}>{shellText("Partager")}</button>}
      <CopyLink href={current && options.pageUrl ? options.pageUrl(current.id) : undefined}/>
      {options.onFavorite && <Favorite value={starred}
        onChange={next => { setStarred(next); options.onFavorite?.(next); }}/>}
      <PageMenu container={surface} fullWidth={fullWidth} onFullWidthChange={onFullWidthChange}
        onHistoryOpen={onHistoryOpen} readOnly={options.readOnly} storedOnDevice={options.storedOnDevice}
        onRename={options.onRename} onDuplicate={options.onDuplicate} onDelete={options.onDelete}
        onHistory={options.onHistory}/>
    </div>
  </>;
};
