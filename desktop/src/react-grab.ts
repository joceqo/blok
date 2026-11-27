import {attachGrabToDialogs} from './react-grab-dialogs';
import type {ReactGrabAPI} from 'react-grab';

export const reactGrabAvailable = import.meta.env.DEV || import.meta.env.VITE_REACT_GRAB === 'true' ||
  (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
let pending: Promise<ReactGrabAPI> | undefined;

export function onReactGrabShortcut(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== 'KeyG') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) window.__REACT_GRAB__?.toggle();
}

/** Initialize the inspector in both native and explicitly enabled web builds. */
export function loadReactGrab(): Promise<ReactGrabAPI> {
  if (!reactGrabAvailable) return Promise.reject(new Error('React Grab n’est pas activé dans cette version.'));
  pending ??= import('react-grab/core').then(({init}) => {
    const api = init({
      enabled: true,
      telemetry: false,
      activationMode: 'toggle',
      // Blok handles this chord directly so it works with a single press in the editor.
      activationKey: () => false,
      freezeReactUpdates: false,
      getContent: (elements) => elements.map((element) => {
        if (element.closest('[data-desktop-mcp-secret]')) return '[jeton masqué]';
        const source = element.closest<HTMLElement>('[data-settings-source]')?.dataset.settingsSource;
        const clone = element.cloneNode(true) as Element;
        // Never include field values or a displayed access token in feedback context.
        for (const input of [clone, ...clone.querySelectorAll('input,textarea,[data-desktop-mcp-secret]')]) {
          if (input.matches('input,textarea')) { input.removeAttribute('value'); input.textContent = ''; }
          if (input.matches('[data-desktop-mcp-secret]')) input.textContent = '[jeton masqué]';
        }
        return `${source ? `Source: ${source}\n` : ''}${clone.outerHTML.slice(0, 4000)}`;
      }).join('\n\n'),
    });
    window.__REACT_GRAB__ = api;
    const detach = attachGrabToDialogs();
    import.meta.hot?.dispose(detach);
    return api;
  }).catch((error: unknown) => { pending = undefined; throw error; });
  return pending;
}
