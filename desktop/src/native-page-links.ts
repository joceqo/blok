import { deviceWorkspaces, nativeBridge } from './native-runtime';
import { parsePageLink } from './page-link';
import { activeWorkspace, selectWorkspace } from './workspace-registry';
import { workspaceRepository } from './workspace-repository';

/** Only the OS bridge can deliver an external request. Device credentials never leave its own API. */
export function listenForPageLinks(report: (error: unknown) => void): void {
  const bridge = nativeBridge();
  if (!bridge) return;
  async function open(): Promise<void> {
    const raw = await bridge!.invoke('take_page_link');
    if (typeof raw !== 'string') return;
    const link = parsePageLink(raw);
    if (!link) throw new Error('Lien de page Blok invalide.');
    let target = activeWorkspace();
    if (link.device) {
      const {references, origin, result} = await deviceWorkspaces();
      if (link.origin && link.origin !== origin) throw new Error('Ce lien appartient à un autre serveur local.');
      const matches = references.filter(ref => !link.workspace || ref.id === link.workspace);
      let found = false;
      for (const ref of matches) {
        const response = await fetch(origin + '/api/workspaces/' + encodeURIComponent(ref.workspaceId) + '/index', {
          headers: {Authorization:'Bearer ' + result.token}, credentials:'omit', redirect:'error',
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
    const {flushDesktop} = await import('./shell');
    await flushDesktop();
    selectWorkspace(target, link.id);
  }
  let pending = Promise.resolve();
  const next = (): void => { pending = pending.then(open).catch(report); };
  window.addEventListener('blok:page-link', next);
  next();
}
