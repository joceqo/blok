import {useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CloudApiError, type CloudClient, type CloudRole} from './client';
import {PAGE_LEVELS, PAGE_RIGHTS_CUMULATIVE, pageLevelOptions} from '../access-vocabulary';
import type {PageLevel} from '../page-access';
import {registerLayer} from '../../../src/components/utils/dismissable-layer';
import {IconLock, IconPeople} from '../../../src/components/icons';

export interface PageShareEntry { userId:string; email:string; level:PageLevel; from?:string }
type Visibility = 'inherit' | 'private' | 'workspace';
export interface PageAccessSheet {
  visibility:Visibility; effectiveVisibility:Visibility; myLevel:PageLevel;
  shares:PageShareEntry[]; inherited:PageShareEntry[];
}
export interface ShareSheetOptions {
  client:Pick<CloudClient,'request'>; slug:string; pageId:string; pageTitle:string; accountId?:string; onChanged?:()=>Promise<void>|void;
}
export interface ShareSheetHandle { destroy():void; refresh():Promise<void> }
type Member = {id:string; name?:string; email:string; role?:CloudRole};
const visibilityNames: Record<Visibility,string> = {
  private:'Personnes invitées uniquement', workspace:'Tous les membres de l’espace', inherit:'Hériter de la page parente',
};
const fold = (value:string) => value.normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toLocaleLowerCase();
function Avatar({label}:{label:string}) {
  return <span data-cloud-share-avatar="" aria-hidden="true">{Array.from(label)[0]?.toLocaleUpperCase()}</span>;
}

function AccessLevel({label,value,disabled,viewer,onChange}:{label:string;value:PageLevel;disabled?:boolean;viewer?:boolean;onChange:(level:PageLevel)=>void}) {
  return <select data-cloud-share-select="" aria-label={label} disabled={disabled} value={value}
    onChange={e=>onChange(e.currentTarget.value as PageLevel)}>
    {pageLevelOptions().filter(option=>!viewer || option.value==='view' || option.value===value).map(option=>
      <option key={option.value} value={option.value} disabled={viewer && option.value!=='view'}>{option.label}</option>)}
  </select>;
}

function MemberPicker({members,granted,disabled,grant}:{members:Member[]|null;granted:Set<string>;disabled:boolean;
  grant:(id:string,level:PageLevel)=>Promise<boolean>}) {
  const [query,setQuery]=useState(''), [selected,setSelected]=useState<Member|null>(null);
  const [level,setLevel]=useState<PageLevel>('view'), [expanded,setExpanded]=useState(false), [active,setActive]=useState(0);
  const input=useRef<HTMLInputElement>(null);
  const listId=useId();
  const list=useRef<HTMLDivElement>(null);
  const candidates=(members ?? []).filter(member=>!granted.has(member.id));
  const normalized=fold(query);
  const matches=candidates.filter(member=>fold((member.name ?? '')+' '+member.email).includes(normalized));
  const shown=expanded && !disabled && members!==null;
  const current=matches[Math.min(active,matches.length-1)];
  useLayoutEffect(()=>{
    if (input.current?.closest('[data-cloud-share-dialog]')===document.activeElement) input.current.focus();
  },[members!==null]);
  useLayoutEffect(()=>{
    if (shown && list.current && input.current) return registerLayer({
      element:list.current, anchor:input.current, outside:false, onDismiss:()=>setExpanded(false),
    });
  },[shown]);
  useEffect(()=>{
    if (shown && current) document.getElementById(listId+'-'+current.id)?.scrollIntoView?.({block:'nearest'});
  },[shown,current?.id,listId]);
  function choose(member:Member) {
    setSelected(member); setQuery(member.name || member.email); setExpanded(false); setLevel('view'); input.current?.focus();
  }
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (!selected || disabled || !candidates.some(candidate=>candidate.id===selected.id)) return;
    if (await grant(selected.id, selected.role==='viewer' ? 'view' : level)) {
      setSelected(null); setQuery(''); setLevel('view'); setExpanded(false);
      input.current?.focus();
    }
  }
  return <form data-cloud-share-invitation="" onSubmit={e=>void submit(e)}>
    <div data-cloud-share-person-picker="">
      <input ref={input} type="text" role="combobox" aria-label="Ajouter une personne" aria-autocomplete="list"
        aria-expanded={shown} aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && current ? listId+'-'+current.id : undefined}
        placeholder={members===null ? 'Chargement des membres…' : 'Nom ou e-mail d’un membre…'}
        autoComplete="off" value={query} disabled={disabled || members===null || !candidates.length}
        onClick={()=>{if(!selected)setExpanded(true);}} onBlur={()=>setExpanded(false)}
        onChange={e=>{setQuery(e.target.value);setSelected(null);setLevel('view');setActive(0);setExpanded(true);}}
        onKeyDown={e=>{
          if(e.nativeEvent.isComposing)return;
          if(e.key==='Escape' && shown){e.preventDefault();e.stopPropagation();setExpanded(false);}
          if(e.key==='ArrowDown'||e.key==='ArrowUp'){
            e.preventDefault();
            setActive(shown ? Math.max(0,Math.min(matches.length-1,active+(e.key==='ArrowDown'?1:-1))) : e.key==='ArrowUp' ? Math.max(0,matches.length-1) : 0);
            setExpanded(true);
          }
          if(e.key==='Enter' && shown){e.preventDefault();if(current)choose(current);}
        }}/>
      <button type="submit" data-cloud-share-add="" disabled={disabled || !selected || granted.has(selected.id)}>Partager</button>
    </div>
    {shown && <div data-cloud-share-matches="">
      <div ref={list} id={listId} role="listbox" aria-label="Membres de l’espace">
        {matches.map((member,index)=><div key={member.id} id={listId+'-'+member.id} role="option" aria-selected={member===current}
          onPointerMove={e=>{if(e.pointerType!=='touch')setActive(index);}} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(member)}>
          <Avatar label={member.name || member.email}/><span><strong>{member.name || member.email}</strong>{member.name && <small>{member.email}</small>}</span>
        </div>)}
      </div>
      {!matches.length && <p role="status">Aucun membre ne correspond à cette recherche.</p>}
    </div>}
    {selected && <div data-cloud-share-invite-level=""><span>{selected.email}</span>
      {selected.role==='viewer' ? <span>{PAGE_LEVELS.view}</span> :
        <AccessLevel label="Accès à accorder" value={level} disabled={disabled} onChange={setLevel}/>}
    </div>}
    {members && !candidates.length && <p data-cloud-share-invite-note="">Tous les membres ont déjà un accès individuel.</p>}
  </form>;
}

function GeneralAccess({sheet,busy,save}:{sheet:PageAccessSheet;busy:boolean;save:(value:Visibility)=>Promise<boolean>}) {
  const [value,setValue]=useState(sheet.visibility);
  const editable=sheet.myLevel==='full';
  return <>
    <h3 data-cloud-share-heading="">Accès général</h3>
    <div data-cloud-share-visibility="">
      <span aria-hidden="true" data-cloud-share-visibility-icon="" dangerouslySetInnerHTML={{__html:sheet.effectiveVisibility==='workspace'?IconPeople:IconLock}}/>
      <div>
        {editable ? <select aria-label="Accès général" data-cloud-share-select="" value={value} disabled={busy}
          onChange={e=>setValue(e.currentTarget.value as Visibility)}>
          {Object.entries(visibilityNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select> : <strong>{visibilityNames[sheet.effectiveVisibility]}</strong>}
        {sheet.visibility==='inherit' && <small>Accès hérité · {visibilityNames[sheet.effectiveVisibility]}</small>}
      </div>
      {editable && value!==sheet.visibility && <button type="button" data-cloud-share-apply="" disabled={busy} onClick={()=>void save(value).then(ok=>{if(!ok)setValue(sheet.visibility);})}>Appliquer</button>}
    </div>
    <details data-cloud-share-rights=""><summary>Détail des droits</summary><p data-cloud-share-cumulative="">{PAGE_RIGHTS_CUMULATIVE}</p></details>
  </>;
}

export function mountShareSheet(container:HTMLElement, options:ShareSheetOptions):ShareSheetHandle {
  const base='/api/workspaces/'+encodeURIComponent(options.slug)+'/pages/'+encodeURIComponent(options.pageId);
  const panel=document.createElement('div');panel.setAttribute('data-cloud-share-sheet','');container.append(panel);
  const root=createRoot(panel);
  let sheet:PageAccessSheet|null=null, members:Member[]|null=null;
  let alive=true, busy=false, loading=true, error='', memberError='', sequence=0;
  const life=new AbortController();
  function message(error:unknown) { return error instanceof Error ? error.message : 'La demande n’a pas pu aboutir. Réessayez.'; }
  async function refresh() {
    const current=++sequence;
    try {
      const result=await options.client.request<PageAccessSheet>(base+'/access',{signal:life.signal});
      if(!alive || current!==sequence)return;
      sheet=result;loading=false;
      if(result.myLevel!=='full'){members=null;memberError='';}
      paint();
      if(result.myLevel==='full' && members===null) {
        try {
          const value=await options.client.request<{members:Member[]}>('/api/workspaces/'+encodeURIComponent(options.slug)+'/members',{signal:life.signal});
          if(!alive || current!==sequence)return;
          members=value.members;memberError='';
        }catch(cause){if(!alive||current!==sequence)return;memberError=message(cause);}
        paint();
      }
    }catch(cause){
      if(!alive||current!==sequence)return;
      sheet=null;members=null;loading=false;error=message(cause);paint();
    }
  }
  function retry(){error='';memberError='';loading=!sheet;paint();void refresh();}
  async function mutate(path:string,method:'PUT'|'DELETE',body?:object) {
    if(busy || !alive || sheet?.myLevel!=='full')return false;
    busy=true;error='';paint();
    try{
      await options.client.request(base+path,{method,...(body && {body:JSON.stringify(body)})});
      if(alive)await refresh();
      await options.onChanged?.();
      return true;
    }catch(cause){
      if(alive) {
        error=message(cause);
        if(cause instanceof CloudApiError && [403,404,409,503].includes(cause.status))await refresh();
      }
      return false;
    }finally{busy=false;paint();}
  }
  function grant(id:string,level:PageLevel){return mutate('/shares/'+encodeURIComponent(id),'PUT',{level});}
  function paint() {
    if(!alive)return;
    panel.setAttribute('aria-busy',String(loading||busy));
    const access=sheet;
    const manager=access?.myLevel==='full';
    const entries=access ? [...access.shares,...access.inherited] : [];
    flushSync(()=>root.render(<>
      {loading && <p role="status">Chargement des accès…</p>}
      {access && <>
        {manager && <MemberPicker members={members} granted={new Set(entries.map(entry=>entry.userId))} disabled={busy} grant={grant}/>}
        {memberError && <p role="alert" data-cloud-share-error="">{memberError} <button type="button" onClick={retry}>Réessayer</button></p>}
        <div data-cloud-share-list="">
          {entries.map(entry=>{
            const member=members?.find(person=>person.id===entry.userId), mine=entry.userId===options.accountId;
            const primary=member?.name || entry.email;
            return <div key={JSON.stringify([entry.from,entry.userId])} data-cloud-share-row="" data-cloud-share-inherited={entry.from!==undefined ? '' : undefined}>
              <Avatar label={primary}/>
              <div data-cloud-share-identity=""><span data-cloud-share-email="" title={primary}>{primary}{mine && ' (vous)'}</span>
                {member?.name && <small>{entry.email}</small>}
                {entry.from!==undefined && <span data-cloud-share-origin="" title={entry.from}>Hérité de la page {entry.from}</span>}
              </div>
              {manager && !entry.from ? <>
                <AccessLevel label={'Niveau d’accès de '+entry.email} value={entry.level} disabled={busy || (member?.role==='viewer' && entry.level==='view')} viewer={member?.role==='viewer'}
                  onChange={level=>void grant(entry.userId,level)}/>
                <button type="button" data-cloud-share-remove="" disabled={busy} aria-label={'Retirer l’accès de '+entry.email}
                  onClick={()=>void mutate('/shares/'+encodeURIComponent(entry.userId),'DELETE')}>Retirer</button>
              </> : <span data-cloud-share-level="">{PAGE_LEVELS[entry.level]}</span>}
            </div>;
          })}
          {!entries.length && <p data-cloud-share-empty="">Aucun accès individuel ajouté à cette page.</p>}
        </div>
        <GeneralAccess key={access.visibility+'-'+access.myLevel} sheet={access} busy={busy}
          save={visibility=>mutate('/access','PUT',{visibility})}/>
      </>}
      {error && <p role="alert" data-cloud-share-error="">{error} {!sheet && <button type="button" onClick={retry}>Réessayer</button>}</p>}
    </>));
  }
  paint();void refresh();
  return {refresh,destroy(){alive=false;life.abort();root.unmount();panel.remove();}};
}
