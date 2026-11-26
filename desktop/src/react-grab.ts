import type {ReactGrabAPI} from 'react-grab';
import {hideTopLayerKeepingPaint, promoteToTopLayer, supportsPopoverAPI} from '../../src/components/utils/top-layer';

import {activeWorkspace} from './workspace-registry';

function clientContext(): string {
  const client = '__TAURI_INTERNALS__' in window ? 'Blok Desktop (Tauri)' : 'Blok Web (navigateur)';
  return `Client: ${client} · ${activeWorkspace().kind === 'local' ? 'espace local' : 'espace serveur'}`;
}

const isGrabShortcut = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'KeyG';

export const reactGrabAvailable = import.meta.env.DEV || import.meta.env.VITE_REACT_GRAB === 'true';
let pending: Promise<ReactGrabAPI> | undefined;

/** Explicit initialization also works in the production-built local demo. */
export function loadReactGrab(): Promise<ReactGrabAPI> {
  if (!reactGrabAvailable) return Promise.reject(new Error('React Grab n’est pas activé dans cette version.'));
  pending ??= import('react-grab/core').then(({init}) => {
    // Claim inspection keys before either the inspector or a Blok dialog handles them.
    let consumedEscape = false;
    let inspector: ReactGrabAPI | undefined;
    const onKey = (event: KeyboardEvent): void => {
      const shortcut = isGrabShortcut(event);
      if (!shortcut && event.key !== 'Escape') return;
      if (!inspector || inspector !== window.__REACT_GRAB__ || !inspector.isEnabled()) return;
      if (!shortcut) {
        if (!event.repeat) consumedEscape = inspector.isActive();
        if (!consumedEscape) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (shortcut) inspector.toggle();
      else inspector.deactivate();
    };
    window.addEventListener('keydown', onKey, true);
    const api = init({
      enabled: true,
      telemetry: false,
      activationMode: 'toggle',
      activationKey: isGrabShortcut,
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
    api.registerPlugin({
      name: 'blok-client',
      hooks: {
        transformCopyContent: (content) => `${clientContext()}\n${content}`,
        transformHtmlContent: (html) => `<!-- ${clientContext()} -->\n${html}`,
      },
    });
    inspector = api;
    window.__REACT_GRAB__ = api;
    attachGrabToDialogs();
    return api;
  }).catch((error: unknown) => { pending = undefined; throw error; });
  return pending;
}

/** A top-layer popover still inherits inert and the dialog's focus boundary from its DOM parent. */
function attachGrabToDialogs(): void {
  const host = document.querySelector<HTMLElement>('[data-react-grab]');
  if (!host) return;
  const surfaces = ['dialog[open]', '[aria-modal="true"]', '[role="menu"]', '[role="listbox"]'];
  if (supportsPopoverAPI()) surfaces.push('[popover]:popover-open:not([data-react-grab])');
  const selector = surfaces.join(', ');
  host.style.background = 'transparent';
  const sync = (bringForward = false): void => {
    const nativeModal = document.activeElement?.closest('dialog:modal') ?? document.querySelector('dialog:modal');
    const candidates = Array.from((nativeModal ?? document).querySelectorAll<HTMLElement>(selector));
    const surface = candidates.reverse().find((element) =>
      !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0);
    const parent = surface ?? nativeModal ?? document.body;
    if (host.parentElement !== parent) parent.append(host);
    host.removeAttribute('inert');
    host.removeAttribute('aria-hidden');
    if (!supportsPopoverAPI()) return;
    if (host.matches(':popover-open')) {
      if (!bringForward) return;
      hideTopLayerKeepingPaint(host);
    }
    promoteToTopLayer(host);
  };
  document.addEventListener('toggle', (event) => {
    if (event.target instanceof HTMLElement && event.target !== host && event.target.matches('dialog, [popover]')) {
      sync((event as ToggleEvent).newState === 'open');
    }
  }, true);
  const observer = new MutationObserver((records) => {
    if (!host.isConnected || records.some((record) => {
      if (record.type === 'attributes') return true;
      return Array.from(record.addedNodes).some((node) =>
        node === host || (node instanceof Element && (node.matches(selector) || node.querySelector(selector))));
    })) sync();
  });
  observer.observe(document.body, {subtree: true, childList: true, attributes: true,
    attributeFilter: ['aria-modal', 'open', 'hidden', 'inert', 'aria-hidden']});
  sync();
}
