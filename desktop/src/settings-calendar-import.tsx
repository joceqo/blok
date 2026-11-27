import {shellText} from './shell-i18n';
import {useLayoutEffect, useRef, useState, type ChangeEvent} from 'react';
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
    <h1 data-desktop-settings-title="">{shellText("Calendrier")}</h1>
    <p data-desktop-settings-intro="">{shellText("Choisissez les agendas visibles dans cet espace.")}</p>
    <div className="cal-sources settings-calendar-sources" ref={host}/>
    <button type="button" data-desktop-settings-copy="" onClick={openAgenda}>{shellText("Ouvrir le calendrier")}</button>
  </>;
}

function ImportSettings({store, importMarkdown}: {store:CalendarStore; importMarkdown?: (file:File)=>Promise<void>}) {
  const host = useRef<HTMLElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const archive = useRef<HTMLInputElement>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file || busy || !importMarkdown) return;
    event.currentTarget.value = '';
    setBusy(true); setError('');
    try { await importMarkdown(file); }
    catch (cause) { setError(cause instanceof Error ? cause.message : shellText("Import impossible.")); }
    finally { setBusy(false); }
  }
  return <>
    <h1 data-desktop-settings-title="">{shellText("Importer")}</h1>
    <p data-desktop-settings-intro="">{shellText("Ajoutez du contenu à cet espace depuis un fichier.")}</p>
    {importMarkdown && <section className="settings-panel-section"><h2>{shellText("Pages")}</h2><div className="settings-panel-row" data-setting="markdown">
      <div className="settings-panel-label"><strong>{shellText("Markdown et CSV")}</strong><small>{store.remote ? shellText("Créer une page privée à partir d’un fichier Markdown ou CSV.") : shellText("Créer une page sur cet appareil à partir d’un fichier Markdown ou CSV.")}</small></div>
      <input ref={picker} type="file" accept=".md,.markdown,text/markdown,.csv,text/csv" hidden aria-label={shellText("Fichier Markdown ou CSV")} onChange={choose}/>
      <button type="button" data-desktop-settings-copy="" disabled={busy} onClick={()=>picker.current?.click()}>{busy ? shellText("Importation…") : shellText("Choisir un fichier")}</button>
    </div>
    <div className="settings-panel-row" data-setting="archive-import">
      <div className="settings-panel-label">
        <strong>{shellText('Notion et dossiers ZIP')}</strong>
        <small>{shellText('Dans Notion, exportez en Markdown et CSV avec les sous-pages, puis choisissez le ZIP. Blok accepte aussi les dossiers compressés de fichiers Markdown, HTML ou CSV (64 Mio maximum).')}</small>
      </div>
      <input ref={archive} type="file" accept=".zip,application/zip" hidden aria-label={shellText('Archive ZIP')} onChange={choose}/>
      <button type="button" data-desktop-settings-copy="" disabled={busy} onClick={()=>archive.current?.click()}>{busy ? shellText('Importation…') : shellText('Choisir un ZIP')}</button>
    </div></section>}
    <section ref={host} className="settings-panel-section"><h2>{shellText("Calendrier")}</h2><div className="settings-panel-row" data-setting="ical">
      <div className="settings-panel-label"><strong>iCalendar</strong><small>{shellText("Vérifier les événements d’un fichier .ics avant de les ajouter à l’agenda.")}</small></div>
      <button type="button" data-desktop-settings-copy="" onClick={async ()=>{
        try {
          const {importCalendarFile} = await import('./calendar-ical');
          if (host.current && !host.current.querySelector('dialog')) importCalendarFile(host.current,store,()=>{});
        } catch { setError(shellText("Impossible de charger l’import du calendrier.")); }
      }}>{shellText("Importer un calendrier")}</button>
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
