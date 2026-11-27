import {shellText} from './shell-i18n';
import { memo, useLayoutEffect, useState, type KeyboardEvent as ReactKeyEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconCross, IconFile, IconLink, IconLinkExternal, IconMessage, IconSearch, IconSidebarRight } from '../../src/components/icons';
import { isImageIcon } from '../../src/shell/page-icon';
import { COVER_PRESETS } from './cover';
import { createNavigationDialog } from './navigation-modal';
import { normalize, searchGroups, type Result, type SearchOptions } from './page-search-results';

function Glyph({svg}: {svg: string}) {
  return <span className="palette-glyph" aria-hidden="true" dangerouslySetInnerHTML={{__html:svg}}/>;
}

function PageIcon({result}: {result: Result}) {
  const icon = result.page?.icon;
  return <span className="palette-icon" aria-hidden="true">
    {icon ? isImageIcon(icon) ? <img src={icon} alt="" draggable={false} referrerPolicy="no-referrer"/> : icon :
      <Glyph svg={result.page ? IconFile : IconMessage}/>}
  </span>;
}

// Match the same accent-insensitive text as the title search while retaining original accents and UTF-16 offsets.
const Highlight = memo(function Highlight({text, query}: {text: string; query: string}) {
  const needle = normalize(query);
  if (!needle) return <>{text}</>;
  const offsets: number[] = [];
  let normalized = '', offset = 0;
  for (const ch of text) {
    const part = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
    for (let i = 0; i < part.length; i++) offsets.push(offset);
    normalized += part;
    offset += ch.length;
  }
  const start = normalized.indexOf(needle);
  if (start < 0) return <>{text}</>;
  const end = offsets[start + needle.length] ?? text.length;
  return <>{text.slice(0, offsets[start])}<mark>{text.slice(offsets[start], end)}</mark>{text.slice(end)}</>;
});

type PreviewProps = {
  item: Result; query: string; options: SearchOptions; onRevoked(): void;
  onOpen(): void; onCopy(): void;
};

function Preview({item, query, options, onRevoked, onOpen, onCopy}: PreviewProps) {
  const [text, setText] = useState('');
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    setText(''); setFailed(false);
    if (!item.page || item.excerpt || !options.preview) return;
    const request = new AbortController();
    void options.preview(item.id, request.signal).then(value => {
      if (request.signal.aborted) return;
      if (options.pages().some(page => page.id === item.id)) setText(value);
      else onRevoked();
    }).catch(() => { if (!request.signal.aborted) setFailed(true); });
    return () => request.abort();
  }, [item.id, Boolean(item.page), item.excerpt, options, onRevoked]);
  const preset = COVER_PRESETS.find(c => c.id === item.page?.cover);
  return <aside className="palette-preview" aria-label={shellText("Aperçu")}>
    <div className="palette-cover" style={preset ? {backgroundImage:preset.background} : undefined}>
      <div className="palette-card-tools">
        {item.page && options.pageUrl && <button type="button" className="palette-icon-button" title={shellText("Copier le lien")} aria-label={shellText("Copier le lien")} onClick={onCopy}><Glyph svg={IconLink}/></button>}
        <button type="button" className="palette-icon-button" title={shellText("Ouvrir")} aria-label={shellText("Ouvrir")} onClick={onOpen}><Glyph svg={IconLinkExternal}/></button>
      </div>
    </div>
    <div className="palette-card-content">
      <div className="palette-card-path">{item.path}</div>
      <h3 className="palette-card-title">{item.title}</h3>
      <p className="palette-excerpt">{failed ? shellText("Aperçu indisponible.") : <Highlight text={item.excerpt || text} query={query}/>}</p>
    </div>
  </aside>;
}

function FooterAction({label, keys, disabled, run}: {label:string; keys:string; disabled:boolean; run():void}) {
  return <button type="button" className="palette-action" disabled={disabled} onClick={run}><kbd>{keys}</kbd>{label}</button>;
}

export function openPageSearch(options: SearchOptions): () => void {
  const label = 'Rechercher dans ' + options.workspaceName;
  const modal = createNavigationDialog(label);
  const surface = modal.surface;
  surface.setAttribute('data-navigation-search', '');
  surface.classList.add('page-search');
  const root = createRoot(surface);
  const listId = 'page-search-' + crypto.randomUUID();
  const media = window.matchMedia?.('(max-width: 700px)');
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  let widePreview = true, narrowPreview = false, titleOnly = !options.searchContent, closed = false;
  let mode: 'pages' | 'chats' = 'pages', query = '', scope = '', selected: string | undefined, feedback = '';
  let hits = new Map<string,string>(), pending = false, failed = false;
  let lookup: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let groups = searchGroups(options, mode, query, scope, hits);
  let matches = [...groups.values()].flat();
  const pages = options.pages();
  const parentIds = new Set(pages.map(page => page.parentId));
  const scopes = pages.filter(page => parentIds.has(page.id));

  function reload() {
    groups = searchGroups(options, mode, query, scope, hits);
    matches = [...groups.values()].flat();
    if (!matches.some(item => item.id === selected)) selected = matches[0]?.id;
    paint();
  }
  function refresh() {
    clearTimeout(timer);
    lookup?.abort();
    hits = new Map();
    failed = false; selected = undefined; feedback = '';
    const input = query.trim();
    const search = options.searchContent;
    pending = Boolean(input && mode === 'pages' && search && !titleOnly && !options.pageLinkFromUrl?.(input));
    reload();
    const scroll = surface.querySelector('.palette-scroll');
    if (scroll) scroll.scrollTop = 0;
    if (!pending || !search) return;
    const request = new AbortController();
    lookup = request;
    timer = setTimeout(async () => {
      try {
        const values = await search(input, request.signal);
        if (request.signal.aborted) return;
        hits = new Map(values.map(hit => [hit.id, hit.excerpt ?? '']));
      } catch {
        if (request.signal.aborted) return;
        failed = true;
      }
      pending = false;
      reload();
    }, 140);
  }

  function authorized(id: string) {
    return mode === 'pages' ? options.pages().some(page => page.id === id) : options.chats?.().some(chat => chat.id === id);
  }
  function open(id: string | undefined, newTab = false) {
    if (!id || !authorized(id)) { reload(); return; }
    const callback = mode === 'chats' ? options.onOpenChat : newTab && options.onOpenTab ? options.onOpenTab : options.onOpen;
    if (!callback) return;
    const view = matches.find(item => item.id === id)?.view;
    modal.close();
    if (view) callback(id, view);
    else callback(id);
  }
  async function copy() {
    const id = selected;
    if (!id || mode !== 'pages' || !options.pageUrl || !authorized(id)) { reload(); return; }
    try {
      await navigator.clipboard.writeText(options.pageUrl(id, matches.find(item => item.id === id)?.view));
      if (id === selected) feedback = 'Lien copié';
    } catch { if (id === selected) feedback = 'Copie impossible'; }
    paint();
  }
  function focusField() { surface.querySelector<HTMLInputElement>('.palette-input')?.focus(); }
  function choose(id: string, scroll = false) {
    if (selected !== id) { selected = id; feedback = ''; paint(); }
    if (scroll) surface.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block:'nearest'});
  }
  function keyboard(e: ReactKeyEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && mode === 'pages' && options.pageUrl) {
      e.preventDefault(); void copy();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const index = matches.findIndex(item => item.id === selected);
      const next = matches[Math.max(0, Math.min(matches.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) choose(next.id, true);
    } else if (e.key === 'Enter') {
      e.preventDefault(); open(selected, e.ctrlKey || e.metaKey);
    }
  }
  function changeMode(next: typeof mode) { mode = next; refresh(); focusField(); }
  function togglePreview() {
    if (media?.matches) narrowPreview = !narrowPreview; else widePreview = !widePreview;
    paint(); focusField();
  }
  // The shell expects the input and its active descendant to exist as soon as the dialog opens.
  function paint() {
    if (closed) return;
    const narrow = Boolean(media?.matches);
    const previewVisible = narrow ? narrowPreview : widePreview;
    const activeIndex = matches.findIndex(match => match.id === selected);
    const item = matches[activeIndex];
    const isPages = mode === 'pages';
    const cardOnly = narrow && previewVisible && Boolean(item);
    const resultId = (id: string) => listId + '-' + encodeURIComponent(id);
    const emptyText = pending ? 'Recherche…' : failed ? 'Recherche dans le contenu indisponible.' : query.trim()
      ? 'Aucun résultat pour « ' + query.trim() + ' »' : isPages ? 'Aucune page à afficher.' : 'Aucune conversation dans cet espace.';
    flushSync(() => root.render(<>
      <div className="palette-header">
        <span className="palette-search-icon"><Glyph svg={IconSearch}/></span>
        <input className="palette-input" type="text" role="combobox" aria-expanded={!cardOnly} aria-autocomplete="list"
          aria-controls={listId} aria-activedescendant={!cardOnly && item ? resultId(item.id) : undefined}
          aria-label={label} placeholder={label + '…'} spellCheck={false} autoComplete="off" value={query}
          onInput={e => { query = e.currentTarget.value; if (narrow) narrowPreview = false; refresh(); }} onKeyDown={keyboard}/>
        <button type="button" className="palette-icon-button palette-preview-toggle" title={cardOnly ? shellText("Afficher les résultats") : shellText("Aperçu")}
          aria-label={shellText("Aperçu")} aria-pressed={previewVisible} disabled={!item && !cardOnly} onClick={togglePreview}><Glyph svg={IconSidebarRight}/></button>
        <button type="button" data-navigation-close="" aria-label={shellText("Fermer")} onClick={modal.close}><Glyph svg={IconCross}/></button>
      </div>
      <div className="palette-filters">
        <button type="button" className="palette-tab" aria-pressed={isPages} onClick={() => changeMode('pages')}>{shellText("Pages")}</button>
        {options.chats && options.onOpenChat && <button type="button" className="palette-tab" aria-pressed={!isPages} onClick={() => changeMode('chats')}>{shellText("Chats")}</button>}
        {isPages && options.searchContent && <><span className="palette-divider"/><button type="button" className="palette-filter" aria-pressed={titleOnly}
          onClick={() => { titleOnly = !titleOnly; refresh(); focusField(); }}>{shellText("Titre uniquement")}</button></>}
        {isPages && scopes.length > 0 && <label className="palette-scope">
          <span className="palette-filter-label">{scope ? 'Dans ' + scopes.find(page => page.id === scope)?.title : shellText("Dans")}</span>
          <span className="palette-caret"><Glyph svg={IconChevronDown}/></span>
          <select className="palette-select" aria-label={shellText("Limiter à une page et ses sous-pages")} value={scope}
            onChange={e => { scope = e.currentTarget.value; selected = undefined; reload(); focusField(); }}>
            <option value="">{shellText("Tout l’espace")}</option>
            {scopes.map(page => <option key={page.id} value={page.id}>{page.title || shellText("Nouvelle page")}</option>)}
          </select>
        </label>}
      </div>
      {cardOnly && <div className="palette-mobile-pager">
        <button type="button" className="palette-icon-button" aria-label={shellText("Résultat précédent")} disabled={activeIndex === 0}
          onClick={() => choose(matches[activeIndex - 1].id)}><Glyph svg={IconChevronLeft}/></button>
        <span aria-live="polite">{shellText("Résultat")} {activeIndex + 1} {shellText("sur")} {matches.length}</span>
        <button type="button" className="palette-icon-button" aria-label={shellText("Résultat suivant")} disabled={activeIndex === matches.length - 1}
          onClick={() => choose(matches[activeIndex + 1].id)}><Glyph svg={IconChevronRight}/></button>
      </div>}
      <div className="palette-body">
        <div className="palette-scroll" hidden={cardOnly}>
          <div className="palette-list" role="listbox" id={listId} aria-label={shellText("Résultats")} aria-busy={pending}>
            {Array.from(groups, ([name, items]) => <div key={name} className="palette-group" role="group" aria-label={name}>
              <div className="palette-group-heading" aria-hidden="true">{name}</div>
              {items.map(result => <div key={result.id} id={resultId(result.id)} className="palette-result" role="option" data-navigation-result=""
                aria-selected={result.id === selected} onPointerMove={e => { if (e.pointerType !== 'touch') choose(result.id); }}
                onMouseDown={e => e.preventDefault()} onClick={e => open(result.id, e.metaKey || e.ctrlKey)}>
                <PageIcon result={result}/>
                <div className="palette-result-copy"><div className="palette-result-line">
                  <span className="palette-result-title" data-navigation-result-title=""><Highlight text={result.title} query={query}/></span>
                  <small className="palette-result-path" data-navigation-result-path="">{result.path}</small>
                </div>
                {query.trim() && result.excerpt && <div className="palette-result-excerpt"><Highlight text={result.excerpt} query={query}/></div>}
                </div>
              </div>)}
            </div>)}
          </div>
          <p className="palette-empty" data-navigation-empty="" role="status" hidden={matches.length > 0}>{emptyText}</p>
        </div>
        {previewVisible && item && <Preview key={mode + ':' + item.id} options={options} item={item} query={query} onRevoked={reload}
          onCopy={() => void copy()} onOpen={() => open(item.id)}/>}
      </div>
      <div className="palette-footer">
        <FooterAction label={shellText("Ouvrir")} keys="↵" disabled={!item} run={() => open(selected)}/>
        {isPages && options.onOpenTab && <FooterAction label={shellText("Nouvel onglet")} keys={mod + ' ↵'} disabled={!item} run={() => open(selected, true)}/>}
        {isPages && options.pageUrl && <FooterAction label={shellText("Copier le lien")} keys={mod + ' L'} disabled={!item} run={() => void copy()}/>}
        <span className="palette-feedback" role="status">{feedback}</span>
      </div>
    </>));
  }
  selected = matches[0]?.id;
  paint();
  media?.addEventListener('change', paint);
  modal.open(surface.querySelector<HTMLInputElement>('.palette-input')!, () => {
    closed = true;
    clearTimeout(timer);
    lookup?.abort();
    media?.removeEventListener('change', paint);
    root.unmount();
  });
  return modal.close;
}
