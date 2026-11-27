import {Fragment, useEffect, useRef, useState} from 'react';
import {shellText} from '../shell-i18n';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from '../components';
import {PageMark} from './page-mark';
import type {PageBreadcrumbChoice, PageBreadcrumbItem} from './types';

/** Au-delà, la liste est repliée derrière « N autres ». */
const SHOWN = 6;

interface Level {
  title: string;
  choices: PageBreadcrumbChoice[];
}

/**
 * Le menu d'une miette : la liste des pages de ce niveau, et un cran plus bas
 * pour chaque page qui a des enfants. Les niveaux s'empilent plutôt que de se
 * remplacer, pour que « ‹ Retour » n'ait rien à recalculer.
 */
const CrumbMenu = ({item, onClose}: {item: PageBreadcrumbItem; onClose(): void}) => {
  const [stack, setStack] = useState<Level[]>([{title: item.menuHeading ?? 'Pages', choices: item.menu ?? []}]);
  const [expanded, setExpanded] = useState(false);
  const level = stack[stack.length - 1];
  const shown = expanded ? level.choices : level.choices.slice(0, SHOWN);
  const hidden = level.choices.length - shown.length;

  function descend(choice: PageBreadcrumbChoice) {
    setStack([...stack, {title: choice.title, choices: choice.children ?? []}]);
    setExpanded(false);
  }

  if (!level.choices.length) {
    return <p data-desktop-breadcrumb-menu-heading="">{shellText("Aucune page dans cet espace")}</p>;
  }
  return <>
    <div data-desktop-breadcrumb-menu-heading="">{level.title}</div>
    {stack.length > 1 && <DropdownMenuItem render={<button type="button"/>} data-desktop-breadcrumb-menu-back=""
      closeOnClick={false} onClick={() => { setStack(stack.slice(0, -1)); setExpanded(false); }}>
      {shellText("‹ Retour")}
    </DropdownMenuItem>}
    {shown.map(choice => (
      <div key={choice.id} data-desktop-breadcrumb-menu-row="" {...(choice.current && {'data-current': ''})}>
        <DropdownMenuItem render={<button type="button"/>} data-desktop-breadcrumb-menu-item={choice.id}
          {...(choice.current && {'aria-current': 'page'})}
          onClick={() => { onClose(); choice.onOpen(); }}>
          <PageMark icon={choice.icon} attribute="data-desktop-breadcrumb-menu-icon"/>
          <span>{choice.title}</span>
        </DropdownMenuItem>
        {choice.children?.length ? <DropdownMenuItem render={<button type="button"/>} data-desktop-breadcrumb-menu-children=""
          aria-label={shellText("Sous-pages de {v0}", {v0: choice.title})}
          closeOnClick={false} onClick={() => descend(choice)}>›</DropdownMenuItem> : null}
      </div>
    ))}
    {hidden > 0 && <DropdownMenuItem render={<button type="button"/>} data-desktop-breadcrumb-menu-more=""
      closeOnClick={false} onClick={() => setExpanded(true)}>
      {shellText("{v0} autres", {v0: hidden})}
    </DropdownMenuItem>}
  </>;
};

const Crumb = ({item, current, container}: {item: PageBreadcrumbItem; current: boolean; container: HTMLElement}) => {
  const [open, setOpen] = useState(false);
  const mark = <>
    <PageMark icon={item.icon} attribute="data-desktop-page-toolbar-icon"/>
    <span data-desktop-page-toolbar-title="">{item.title}</span>
  </>;
  const marks = {...(current && {'aria-current': 'page' as const}), title: item.title};

  // Aller à la page l'emporte sur lister ses voisines. La page courante, elle,
  // n'a nulle part où aller : c'est à elle que revient le menu.
  if (item.onOpen) return <button type="button" {...marks} onClick={item.onOpen}>{mark}</button>;
  if (!item.menu) return <span {...marks}>{mark}</span>;
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger render={<button type="button"/>} {...marks}>{mark}</DropdownMenuTrigger>
    <DropdownMenuContent data-desktop-breadcrumb-menu="" container={container}
      aria-label={shellText("Naviguer entre les pages")}>
      <CrumbMenu item={item} onClose={() => setOpen(false)}/>
    </DropdownMenuContent>
  </DropdownMenu>;
};

export const Breadcrumbs = ({items, container}: {items: PageBreadcrumbItem[]; container: HTMLElement}) => {
  const trail = useRef<HTMLElement>(null);
  // Le fil déborde par la gauche : c'est la page courante qu'il faut voir.
  useEffect(() => { if (trail.current) trail.current.scrollLeft = trail.current.scrollWidth; }, [items]);

  return <nav ref={trail} data-desktop-page-breadcrumbs="" aria-label={shellText("Fil d’Ariane")}>
    <ol>
      {items.map((item, index) => <Fragment key={item.id}>
        {index > 0 && <li data-desktop-page-breadcrumb-separator="" aria-hidden="true">/</li>}
        <li data-desktop-page-breadcrumb-item="" data-page-id={item.id}>
          <Crumb item={item} current={index === items.length - 1} container={container}/>
        </li>
      </Fragment>)}
    </ol>
  </nav>;
};
