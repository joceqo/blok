import type { CalendarEvent, CalendarStore } from './calendar-store';
import './calendar-sources.css';

type Source = {kind: 'google'|'member'|'feed'; id:string; label:string; color:string; primary?:boolean};
type Group = Source['kind'];
const palette = ['#4682a3','#ad7161','#8874b0','#b38c3e','#598e7f'];
const color = (id: string) => palette[Array.from(id).reduce((n,c)=>n+c.charCodeAt(0),0) % palette.length];
const key = (s:Source) => s.kind + ':' + s.id;

function element<K extends keyof HTMLElementTagNameMap>(tag:K, text?:string) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}
function action(label:string, fn:()=>void) {
  const button = element('button',label); button.type = 'button'; button.onclick = fn; return button;
}
function readFeed(text:string, from:string, to:string):Promise<CalendarEvent[]> {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL('./calendar-feed.worker.ts', import.meta.url), {type:'module'});
    const timer = setTimeout(() => {worker.terminate(); reject(new Error('Le flux met trop de temps à répondre.'));}, 6000);
    const done = () => {clearTimeout(timer); worker.terminate();};
    worker.onmessage = ({data}) => {done(); if (data.error) reject(new Error(data.error)); else resolve(data.events);};
    worker.onerror = () => {done(); reject(new Error('Flux illisible.'));};
    worker.postMessage({text,from,to});
  });
}

export function mountCalendarSources(container:HTMLElement, store:CalendarStore, onChange:()=>void) {
  const remote = store.remote;
  const prefix = 'blok:calendar:layers:' + (remote?.preferenceKey ?? 'disk');
  let selected:Record<string,boolean> = {};
  try { selected = JSON.parse(localStorage.getItem(prefix) || '{}') ?? {}; } catch { /* use defaults */ }
  let sources:Source[] = [], sharing = false, connected = false, configured = false, destroyed = false;
  let serial = 0, message = '', metaError = '', readSerial = 0;
  const active = (s: Source) => selected[key(s)] ?? (s.kind === 'feed' || s.primary === true);
  function toggle(k:string, visible:boolean) {
    selected[k] = visible;
    try {localStorage.setItem(prefix,JSON.stringify(selected));} catch { /* in-memory preferences */ }
    onChange();
  }
  const api = <T>(path:string, init?:RequestInit) => remote!.client.request<T>(remote!.base + path,init);
  function checkbox(name:string,value:boolean,tint:string,change:(on:boolean)=>void) {
    const line = element('label'), box = element('input');
    box.type = 'checkbox'; box.checked = value; box.style.setProperty('--cal-source-color',tint);
    box.onchange = () => change(box.checked); line.append(box,element('span',name)); return line;
  }
  function report(error:unknown) { message = error instanceof Error ? error.message : 'Source indisponible.'; render(); }
  async function transact(fn:()=>Promise<void>) {
    try { await fn(); await reload(); if (!destroyed) onChange(); }
    catch (error) { if (!destroyed) report(error); }
  }
  function addFeed() {
    if (container.querySelector('form')) return;
    const form = element('form'), title = element('input'), url = element('input');
    title.placeholder = 'Nom de l’agenda'; title.setAttribute('aria-label',title.placeholder); title.required = true; title.maxLength = 120;
    url.type = 'text'; url.placeholder = 'URL WebCal ou HTTPS'; url.setAttribute('aria-label',url.placeholder); url.required = true;
    const submit = element('button','Ajouter'); submit.type = 'submit';
    form.append(title,url,submit,action('Annuler',()=>form.remove()));
    form.onsubmit = e => {e.preventDefault(); submit.disabled = true; void transact(async () => {
      await api('/feeds',{method:'POST',body:JSON.stringify({label:title.value,url:url.value})});
    });};
    container.append(form); title.focus();
  }
  async function connect() {
    const {url} = await api<{url:string}>('/google/connect',{method:'POST'});
    if (destroyed) return;
    const dest = new URL(url);
    if (dest.origin !== 'https://accounts.google.com' || dest.pathname !== '/o/oauth2/v2/auth') throw new Error('Adresse de connexion Google invalide.');
    const bridge = (window as Window & {__TAURI_INTERNALS__?:{invoke:(cmd:string,args:Record<string,string>)=>Promise<void>}}).__TAURI_INTERNALS__;
    if (bridge) await bridge.invoke('open_calendar_authorization',{url:dest.href});
    else window.location.assign(dest.href);
  }
  function render() {
    if (destroyed) return;
    container.replaceChildren();
    const group = (name:string) => {const section=element('section');section.append(element('h3',name));container.append(section);return section;};
    group('Agendas').append(checkbox('Espace de travail',selected.workspace !== false,'#54836b',on=>toggle('workspace',on)));
    if (remote) {
      const fill = (section:HTMLElement,kind:Group) => {
        for (const s of sources.filter(s=>s.kind === kind)) {
          const row=element('div'); row.className='cal-layer-row';
          row.append(checkbox(s.label,active(s),s.color,on=>toggle(key(s),on)));
          if(kind === 'feed') {
            const del=action('×',()=>void transact(async()=>{await api('/feeds/'+encodeURIComponent(s.id),{method:'DELETE'});}));
            del.setAttribute('aria-label','Retirer l’abonnement '+s.label); row.append(del);
          }
          section.append(row);
        }
      };
      const google = group('Google Agenda');
      fill(google,'google');
      if (connected) google.append(action('Déconnecter Google',()=>void transact(async()=>{await api('/google/connection',{method:'DELETE'});})));
      else if (configured) google.append(action('Connecter Google',()=>void connect().catch(report)));
      else google.append(element('small','Connexion à configurer sur le serveur.'));
      const feeds = group('Abonnements'); fill(feeds,'feed'); feeds.append(action('+ Ajouter un agenda',addFeed));
      const team = group('Disponibilités de l’équipe'); fill(team,'member');
      if (!sources.some(s=>s.kind==='member')) team.append(element('small','Aucun agenda partagé.'));
      if (connected || sharing) team.append(checkbox('Partager mes créneaux occupés',sharing,'#54836b',enabled=>void transact(async()=>{
        await api('/sharing',{method:'PUT',body:JSON.stringify({enabled})});
      })));
      container.append(action('Actualiser',()=>void transact(async()=>{})));
    }
    const note=element('small',[metaError,message].filter(Boolean).join(' ')); note.setAttribute('role','status'); container.append(note);
  }
  async function reload() {
    if (!remote) return;
    const generation = ++serial;
    const [google,team,feeds] = await Promise.allSettled([
      (async()=>{const status=await api<{configured:boolean;connected:boolean}>('/google/status');
        const list=status.connected ? (await api<{calendars:{id:string;title:string;color:string;primary?:boolean}[]}>('/google/calendars')).calendars : [];
        return {status, list};})(),
      api<{members:{id:string;name:string}[];sharing:boolean}>('/members'),
      api<{feeds:{id:string;label:string}[]}>('/feeds'),
    ]);
    if (destroyed || generation!==serial) return;
    metaError = [google,team,feeds].some(r=>r.status==='rejected') ? 'Certaines sources sont indisponibles.' : '';
    sources=[];
    configured = google.status==='fulfilled' && google.value.status.configured;
    connected = google.status==='fulfilled' && google.value.status.connected;
    sharing = team.status==='fulfilled' && team.value.sharing;
    if (google.status==='fulfilled') for (const s of google.value.list) sources.push({kind:'google',id:s.id,label:s.title,primary:s.primary,color:/^#[0-9a-f]{6}$/i.test(s.color)?s.color:color(s.id)});
    if (feeds.status==='fulfilled') for (const s of feeds.value.feeds) sources.push({...s,kind:'feed',color:color(s.id)});
    if (team.status==='fulfilled') for (const s of team.value.members) sources.push({id:s.id,label:s.name,color:color(s.id),kind:'member'});
    render();
  }
  render();
  let ready=reload();
  const refresh=()=>{if(document.visibilityState!=='hidden' && !destroyed){ready=reload(); void ready.then(()=>{if(!destroyed)onChange();});}};
  window.addEventListener('focus',refresh);
  const timer=remote ? window.setInterval(refresh, 300000) : undefined;
  return {
    workspaceVisible:()=>selected.workspace!==false,
    destroy(){destroyed=true;window.removeEventListener('focus',refresh);window.clearInterval(timer);},
    async list(from:string,to:string):Promise<CalendarEvent[]> {
      const gen=++readSerial;
      await ready;
      if (!remote || destroyed) return [];
      const qs=new URLSearchParams({from,to});
      const failures:string[]=[];
      const layers=await Promise.all(sources.filter(active).map(async s=>{
        try {
          let result:CalendarEvent[];
          if (s.kind==='google') result=(await api<{events:CalendarEvent[]}>('/google/events?'+qs+'&calendarId='+encodeURIComponent(s.id))).events;
          else if(s.kind==='member') {
            const {busy}=await api<{busy:{start:string;end:string}[]}>('/members/'+encodeURIComponent(s.id)+'/freebusy?'+qs);
            result=busy.map(slot=>({...slot,id:slot.start,title:'Occupé · '+s.label,allDay:false,pageId:null,revision:0}));
          } else {
            const {ical}=await api<{ical:string}>('/feeds/'+encodeURIComponent(s.id)); result=await readFeed(ical,from,to);
          }
          return result.map(e=>({...e,id:JSON.stringify([key(s),e.id]),source:{id:key(s),label:s.label,color:s.color}}));
        } catch { failures.push(s.label); return []; }
      }));
      if (gen===readSerial && !destroyed) {
        const next = failures.length ? 'Indisponible : '+failures.join(', ')+'.' : '';
        if (message!==next) {message=next;render();}
      }
      return layers.flat();
    },
  };
}
