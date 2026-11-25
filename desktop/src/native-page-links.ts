import { deviceWorkspaces, nativeBridge } from './native-runtime';
import { parsePageLink } from './page-link';
import { activeWorkspace, selectStartupPage, selectWorkspace } from './workspace-registry';
import { workspaceRepository } from './workspace-repository';

/** Only the OS bridge can deliver an external request. Device credentials never leave its own API. */
export async function listenForPageLinks(report: (error: unknown) => void): Promise<void> {
  const bridge = nativeBridge();
  if (!bridge) return;
  let starting = true;
  async function open(): Promise<void> {
    const raw = await bridge!.invoke('take_page_link');
    if (typeof raw !== 'string') return;
    const link = parsePageLink(raw);
    if (!link) throw new Error('Lien de page Blok invalide.');
    let target = activeWorkspace();
    if (link.device || (target.kind === 'remote' && target.device)) {
      const {references, origin, result} = await deviceWorkspaces();
      if (link.origin && link.origin !== origin) throw new Error('Ce lien appartient à un autre serveur local.');
      const workspace = link.workspace ?? (!link.device ? target.id : undefined);
      const matches = references.filter(ref => !workspace || ref.id === workspace);
      let found = false;
      for (const ref of matches) {
        const response = await fetch(origin + '/api/workspaces/' + encodeURIComponent(ref.workspaceId) + '/index', {
          headers: {Authorization:'Bearer ' + result.token}, credentials:'omit', redirect:'error',
          signal: AbortSignal.timeout(15000),
        });
        if (response.status === 403 || response.status === 404) continue;
        if (!response.ok) throw new Error('Impossible de lire cet espace.');
        const index = await response.json() as {pages: {id: string}[]};
        if (index.pages.some(page => page.id === link.id)) { target = ref; found = true; break; }
      }
      if (!found) throw new Error('Page introuvable dans les espaces de cet appareil.');
    } else if (!(await workspaceRepository(target).loadIndex()).pages.some(page => page.id === link.id)) {
      throw new Error('Page introuvable dans cet espace.');
    }
    if (starting) {
      selectStartupPage(target, link.id);
      return;
    }
    const {flushDesktop, openMountedPage} = await import('./shell');
    if (await openMountedPage(target, link.id)) return;
    await flushDesktop();
    selectWorkspace(target, link.id);
  }
  let pending = Promise.resolve();
  let startupError: unknown;
  function next(): void {
    pending = pending.then(open).catch(error => {
      if (starting) startupError = error;
      else report(error);
    });
  }
  // Register before reading the OS queue: an open event can arrive during that first IPC.
  window.addEventListener('blok:page-link', next);
  next();
  let reading: Promise<void>;
  do {
    reading = pending;
    await reading;
  } while (reading !== pending);
  starting = false;
  if (startupError) throw startupError;
}
