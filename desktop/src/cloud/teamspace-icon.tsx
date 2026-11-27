import {shellLocale, shellText} from '../shell-i18n';
import {useId, useLayoutEffect, useEffect, useRef, useState} from 'react';
import {registerLayer} from '../../../src/components/utils/dismissable-layer';
import {createPositionTracker, positionFixedAnchored} from '../../../src/components/utils/popover/anchored-position';
import {loadEmojiData, searchEmojis, type ProcessedEmoji} from '../../../src/components/utils/emoji/emoji-data';
import {loadEmojiLocale, type EmojiLocaleData} from '../../../src/components/utils/emoji/emoji-locale';
import {teamspaceColors, teamspaceImage, teamspaceSymbols} from './teamspace-icon-catalog';
import './teamspace-icon.css';

export function TeamspaceIcon({value, name}: {value:string; name:string}) {
  const [type, key, color] = value.split(':', 3);
  const symbol = type === 'icon' ? teamspaceSymbols.find(([id]) => id === key) : undefined;
  if (symbol) return <span className="team-icon" aria-hidden="true" style={{color:teamspaceColors[color]?.css}}
    dangerouslySetInnerHTML={{__html:symbol[2]}}/>;
  if (value.startsWith('data:image/png;base64,')) return <span className="team-icon" aria-hidden="true"><img src={value} alt=""/></span>;
  const fallback = Array.from(name.trim())[0]?.toLocaleUpperCase() || 'T';
  return <span className="team-icon" aria-hidden="true">{value && type !== 'icon' ? value : fallback}</span>;
}

type PickerProps = {value:string; onChange:(next:string)=>void; disabled?:boolean; label?: string; name?:string};
const tabs = ['Icônes', 'Émojis', 'Importer'] as const;
type Tab = typeof tabs[number];

export function TeamspaceIconPicker({value, onChange, disabled, label = shellText('Modifier l’icône'), name = ''}: PickerProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open,setOpen] = useState(false);
  return <>
    <button type="button" ref={trigger} className="team-icon-trigger" aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={()=>setOpen(!open)}><TeamspaceIcon value={value} name={name}/></button>
    {open && <IconPopover id={id} anchor={trigger.current!} value={value} close={()=>setOpen(false)} select={onChange}/>}
  </>;
}

function IconPopover({id, anchor, value, close, select}: {id:string; anchor:HTMLElement; value:string; close():void; select(next:string):void}) {
  const surface = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const [tab,setTab] = useState<Tab>('Icônes');
  const [query,setQuery] = useState('');
  const [color,setColor] = useState(value.startsWith('icon:') ? value.split(':')[2] || 'gray' : 'gray');
  const [palette,setPalette] = useState(false);
  const [emojis,setEmojis] = useState<ProcessedEmoji[]>([]);
  const [locale,setLocale] = useState<EmojiLocaleData|null>(null);
  const [error,setError] = useState('');
  const [limit,setLimit] = useState(120);
  const [busy,setBusy] = useState(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(()=>{
    const panel = surface.current!;
    active.current = true;
    panel.showPopover?.();
    const position = () => positionFixedAnchored(panel, anchor, {side:'bottom',align:'center',offset:6});
    position();
    const tracker = createPositionTracker(panel, position, anchor);
    tracker.attach();
    const unregister = registerLayer({element:panel, anchor, onDismiss(reason){
      closeRef.current();
      if (reason === 'escape') anchor.focus();
    }});
    field.current?.focus();
    return ()=>{active.current=false; unregister(); tracker.detach();};
  },[anchor]);
  useEffect(()=>{
    if(tab !== 'Émojis') return;
    let cancelled = false;
    Promise.all([loadEmojiData(),loadEmojiLocale(shellLocale())]).then(([data,translations])=>{
      if (!cancelled) {setEmojis(data); setLocale(translations);}
    }).catch(()=>{if(!cancelled)setError(shellText("Impossible de charger les émojis."));});
    return ()=>{cancelled=true;};
  },[tab]);

  function choose(next:string) {
    select(next);
    close();
    anchor.focus();
  }
  function switchTab(next:Tab) {
    // La palette n'existe que sur les icones : changer d'onglet la referme.
    setPalette(false);
    setTab(next); setQuery(''); setLimit(120); setError('');
  }
  const fold = (s:string)=>s.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase();
  const options = tab === 'Icônes' ? teamspaceSymbols.filter(([key,title])=>fold(key+' '+title).includes(fold(query)))
    .map(([key,title])=>({value:'icon:'+key+(color==='gray' ? '' : ':'+color),title}))
    : searchEmojis(emojis,query,locale).map(emoji=>({value:emoji.native,title:locale?.[emoji.native]?.n ?? emoji.name}));
  return <div className="team-icon-popover" ref={surface} id={id} popover="manual" role="dialog" aria-label={shellText("Choisir une icône")}>
    <div className="team-icon-tabs">
      {tabs.map(t=><button type="button" key={t} aria-pressed={tab === t} onClick={()=>switchTab(t)}>{shellText(t)}</button>)}
      <button type="button" disabled={!value || busy} onClick={()=>choose('')}>{shellText("Retirer")}</button>
    </div>
    {tab === 'Importer' ? <label className="team-icon-upload">{shellText("Choisir une image")} <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={async e=>{
        const file=e.currentTarget.files?.[0]; if(!file)return;
        e.currentTarget.value=''; setBusy(true); setError('');
        try {const data=await teamspaceImage(file); if(active.current)choose(data);}
        catch(err){if(active.current)setError(err instanceof Error ? err.message : shellText("Image illisible."));}
        finally {if(active.current)setBusy(false);}
      }}/><small>{shellText("PNG, JPEG ou WebP · 5 Mo maximum")}</small></label> : <>
      <div className="team-icon-tools">
        <input type="search" aria-label={shellText("Filtrer les icônes ou les émojis")} placeholder={shellText("Filtrer…")} ref={field} value={query}
          onChange={e=>{setQuery(e.target.value); setLimit(120);}} onKeyDown={e=>{
            if (e.key==='Enter' && !e.nativeEvent.isComposing && options.length) {e.preventDefault(); choose(options[0].value);}
          }}/>
        <button type="button" aria-label={shellText("Choisir au hasard")} title={shellText("Choisir au hasard")} disabled={!options.length}
          onClick={()=>choose(options[Math.floor(Math.random()*options.length)].value)}>⤨</button>
        {/* Une palette plutot qu'un menu natif : celui-ci s'ouvrait au theme
            du systeme, rangee bleue comprise, qu'aucune feuille de
            l'application n'atteint, et ses pastilles sortaient toutes
            noires. Elle tient dans un panneau pour ne pas pousser le champ
            de filtre hors de la rangee. */}
        {tab==='Icônes' && <div className="team-icon-color-picker">
          <button type="button" className="team-icon-color-trigger" aria-haspopup="true" aria-expanded={palette}
            aria-label={shellText("Couleur de l’icône")} title={teamspaceColors[color]?.label}
            style={{color:teamspaceColors[color]?.css}} onClick={()=>setPalette(!palette)}/>
          {palette && <div className="team-icon-colors" role="group" aria-label={shellText("Couleur de l’icône")}>
            {Object.entries(teamspaceColors).map(([key,c])=><button key={key} type="button" title={c.label}
              aria-label={c.label} aria-pressed={color===key} style={{color:c.css}}
              onClick={()=>{setColor(key); setPalette(false);}}/>)}
          </div>}
        </div>}
      </div>
      <div className="team-icon-scroll">
        <div className="team-icon-grid">{options.slice(0,limit).map(o=><button key={o.value} type="button" title={o.title}
          aria-label={o.title} aria-pressed={value===o.value} onClick={()=>choose(o.value)}><TeamspaceIcon name={o.title} value={o.value}/></button>)}</div>
        {options.length>limit && <button type="button" className="team-icon-more" onClick={()=>setLimit(limit+120)}>{shellText("Afficher plus d’émojis")}</button>}
        {!options.length && !error && <p role="status">{tab==='Émojis'&&!emojis.length?shellText("Chargement…"):shellText("Aucun résultat")}</p>}
      </div>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
