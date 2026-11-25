import {useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {mountCalendarSources} from './calendar-sources';
import {createCalendarStore, type CalendarStore} from './calendar-store';
import type {CloudClient} from './cloud/client';
import type {WorkspaceRef} from './workspace-registry';

type Options =
  | {kind:'calendar'; openAgenda():void}
  | {kind:'import'; importMarkdown?: (file:File)=>Promise<void>};

function CalendarSettings({store, openAgenda}: {store:CalendarStore; openAgenda():void}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    const sources = mountCalendarSources(host.current, store, () => {});
    return () => sources.destroy();
  }, [store]);
  return <>
    <h1 data-desktop-settings-title="">Calendrier</h1>
    <p data-desktop-settings-intro="">Choisissez les agendas visibles dans cet espace.</p>
    <div className="cal-sources settings-calendar-sources" ref={host}/>
    <button type="button" data-desktop-settings-copy="" onClick={openAgenda}>Ouvrir le calendrier</button>
  </>;
}

function ImportSettings({store, importMarkdown}: {store:CalendarStore; importMarkdown?: (file:File)=>Promise<void>}) {
  const host = useRef<HTMLElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  return <>
    <h1 data-desktop-settings-title="">Importer</h1>
    <p data-desktop-settings-intro="">Ajoutez du contenu à cet espace depuis un fichier.</p>
    {importMarkdown && <section className="settings-panel-section"><h2>Pages</h2><div className="settings-panel-row">
      <div className="settings-panel-label"><strong>Markdown</strong><small>{store.remote ? 'Créer une page privée à partir d’un fichier .md.' : 'Créer une page sur cet appareil à partir d’un fichier .md.'}</small></div>
      <input ref={picker} type="file" accept=".md,.markdown,text/markdown" hidden aria-label="Fichier Markdown" onChange={async event => {
        const file = event.currentTarget.files?.[0]; if (!file || busy) return;
        event.currentTarget.value = ''; setBusy(true); setError('');
        try { await importMarkdown(file); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Import impossible.'); }
        finally { setBusy(false); }
      }}/>
      <button type="button" data-desktop-settings-copy="" disabled={busy} onClick={()=>picker.current?.click()}>{busy ? 'Importation…' : 'Choisir un fichier'}</button>
    </div></section>}
    <section ref={host} className="settings-panel-section"><h2>Calendrier</h2><div className="settings-panel-row">
      <div className="settings-panel-label"><strong>iCalendar</strong><small>Vérifier les événements d’un fichier .ics avant de les ajouter à l’agenda.</small></div>
      <button type="button" data-desktop-settings-copy="" onClick={async ()=>{
        try {
          const {importCalendarFile} = await import('./calendar-ical');
          if (host.current && !host.current.querySelector('dialog')) importCalendarFile(host.current,store,()=>{});
        } catch { setError('Impossible de charger l’import du calendrier.'); }
      }}>Importer un calendrier</button>
    </div></section>
    {error && <p role="alert">{error}</p>}
  </>;
}

export function mountCalendarImportSettings(host:HTMLElement, ref:WorkspaceRef, client:CloudClient | null, options:Options) {
  const store=createCalendarStore(ref, client ?? undefined);
  const root=createRoot(host);
  flushSync(()=>root.render(options.kind==='calendar'
    ? <CalendarSettings store={store} openAgenda={options.openAgenda}/>
    : <ImportSettings store={store} importMarkdown={options.importMarkdown}/>));
  return {destroy:()=>root.unmount()};
}
