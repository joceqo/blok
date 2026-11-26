import { pageView, workspacePageLink } from '../page-link';
import { openModalDialog } from '@blok/modal-dialog';
import { promoteToTopLayer, removeFromTopLayer } from '../../../src/components/utils/top-layer';
import { CloudClient } from './client';
import { mountShareSheet } from './share-sheet';
import type { RemoteWorkspace } from '../workspace-registry';
import { nativeSessionAdapter } from '../native-session';
import { IconCross, IconLink } from '../../../src/components/icons';
import './share-sheet.css';

let active: { anchor?: HTMLElement; close: () => void } | undefined;

/** Same access sheet in a toolbar popover, or a modal for callers without an anchor. */
export function openPageSharing(ref: RemoteWorkspace, pageId: string, pageTitle: string, anchor?: HTMLButtonElement, onChanged?: () => Promise<void> | void): () => void {
  const url = new URL(location.href);
  const view = url.searchParams.get('page') === pageId ? pageView(url) : 'document';
  const same = active?.anchor === anchor && active !== undefined;
  active?.close();
  if (same) return () => {};
  const overlay = document.createElement('div');
  overlay.setAttribute('data-desktop-settings-overlay', '');
  overlay.setAttribute('data-cloud-share-overlay', '');
  const surface = document.createElement('section');
  surface.setAttribute('data-cloud-share-dialog', '');
  surface.setAttribute('role', 'dialog');
  surface.tabIndex = -1;
  const heading = document.createElement('h2');
  heading.id = `share-${crypto.randomUUID()}`;
  heading.textContent = 'Partager';
  surface.setAttribute('aria-label', 'Partager ' + pageTitle);
  const title = document.createElement('p');
  title.setAttribute('data-cloud-share-title', '');
  title.textContent = pageTitle;
  title.title = pageTitle;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.setAttribute('data-cloud-share-close', '');
  closeButton.setAttribute('aria-label', 'Fermer le partage');
  closeButton.innerHTML = IconCross;
  heading.append(closeButton);
  surface.append(heading, title);
  overlay.append(surface);
  const sheet = mountShareSheet(surface, {
    client: new CloudClient({ origin: ref.server, ...('__TAURI_INTERNALS__' in window ? { sessionAdapter: nativeSessionAdapter(ref.server) } : {}) }),
    slug: ref.workspaceId, pageId, pageTitle, accountId:ref.accountId, onChanged,
  });
  const footer = document.createElement('footer');
  const hint = document.createElement('span');
  hint.textContent = 'Seules les personnes autorisées ont accès.';
  const copy = document.createElement('button');
  copy.type = 'button';
  const linkIcon = document.createElement('span'); linkIcon.setAttribute('aria-hidden', 'true'); linkIcon.innerHTML = IconLink;
  copy.append(linkIcon, 'Copier le lien');
  copy.addEventListener('click', () => {
    void (async () => {
      try { await navigator.clipboard.writeText(workspacePageLink(ref, pageId, view)); hint.textContent = 'Lien copié'; }
      catch { hint.textContent = 'La copie du lien a échoué.'; }
    })();
  });
  hint.setAttribute('role', 'status');
  footer.append(hint, copy); surface.append(footer);
  if (!anchor) {
    const dialog = openModalDialog({ content: overlay, surface, label: 'Partager ' + pageTitle,
      onDismiss: () => dialog.close(), onClose: () => { sheet.destroy(); active = undefined; },
    });
    closeButton.onclick = () => dialog.close();
    active = { close: () => dialog.close() };
    return active.close;
  }
  // Keep inherited theme tokens and core popovers in the same UI subtree.
  surface.setAttribute('data-cloud-share-anchored', '');
  anchor.parentElement!.append(surface);
  anchor.setAttribute('aria-expanded', 'true');
  const close = (): void => {
    sheet.destroy(); removeFromTopLayer(surface); surface.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key);
    window.removeEventListener('resize', place);
    document.removeEventListener('scroll', place, true);
    window.visualViewport?.removeEventListener('resize', place);
    if (active?.close === close) active = undefined;
  };
  const outside = (event: PointerEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (surface.contains(event.target) || anchor.contains(event.target) || event.target.closest('[data-desktop-choice-popover]')) return;
    close();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); anchor.focus(); }
  };
  const place = (): void => {
    const rect = anchor.getBoundingClientRect();
    const height = window.visualViewport?.height ?? window.innerHeight;
    const top = window.visualViewport?.offsetTop ?? 0;
    const width = Math.min(460, window.innerWidth - 16);
    surface.style.width = `${width}px`;
    surface.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    const below = top + height - rect.bottom - 16;
    const above = rect.top - top - 16;
    const useAbove = below < 220 && above > below;
    surface.style.maxHeight = Math.max(0, useAbove ? above : below) + 'px';
    surface.style.top = (useAbove ? Math.max(top + 8, rect.top - surface.offsetHeight - 8) : rect.bottom + 8) + 'px';
  };
  promoteToTopLayer(surface); place(); surface.focus();
  closeButton.onclick = () => { close(); anchor.focus(); };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key);
  window.addEventListener('resize', place);
  document.addEventListener('scroll', place, true);
  window.visualViewport?.addEventListener('resize', place);
  active = { anchor, close };
  return close;
}
