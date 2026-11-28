import type {I18n} from '../../../types';
import {loadSheet} from '../../components/utils/lazy-styles';
import {DatabaseCardDrawer} from './database-card-drawer';

export interface HostPageSheetOptions {
  pageId: string;
  title: string;
  i18n?: I18n;
  onClose(): void;
  onOpenFullPage(): void;
  onPrevious?(): void;
  onNext?(): void;
}

/** Mount the host's complete page inside the existing table drawer without creating a second editor. */
export function mountHostPageSheet(wrapper: HTMLElement, editorSlot: HTMLElement, options: HostPageSheetOptions) {
  if (!editorSlot.parentNode) throw new Error('The page must be mounted before it can open in a sheet.');
  void loadSheet('database');
  const origin = document.createComment('page editor');
  editorSlot.before(origin);
  let previous = false, next = false, disposed = false, closed = false, attached = false;
  let focusObserver: MutationObserver | undefined;
  const stopWatchingFocus = (): void => {
    focusObserver?.disconnect();
    focusObserver = undefined;
    document.removeEventListener('focusin', stopWatchingFocus);
  };
  function restore() {
    stopWatchingFocus();
    if (attached) origin.parentNode?.insertBefore(editorSlot, origin.nextSibling);
    attached = false;
  }
  const drawer = new DatabaseCardDrawer({
    wrapper, i18n: options.i18n, readOnly: false, schema: [], titlePropertyId: 'title',
    onTitleChange() {}, onDescriptionChange() {},
    hostedPage: {
      label: options.title,
      initialFocus: () => editorSlot.querySelector<HTMLElement>('[data-blok-testid="page-header-title"][contenteditable="true"]:not([inert] *)') ??
        editorSlot.querySelector<HTMLElement>('[contenteditable="true"]:not([inert] *)'),
      canStep: direction => direction === -1 ? previous : next,
      step: direction => direction === -1 ? options.onPrevious?.() : options.onNext?.(),
    },
    rowBody: {
      attach(_id, host) {
        host.append(editorSlot); attached = true;
        return true;
      },
      detach() {
        restore();
        if (closed && !disposed) options.onClose();
      },
    },
    onClose() {
      closed = true;
      // A side peek keeps the body until its exit transition ends.
      if (!attached && !disposed) options.onClose();
    },
    onExpand() { options.onOpenFullPage(); return true; },
  });
  drawer.open({id: options.pageId, position:'0', properties:{title:options.title}});
  // Remote pages can receive edit permission just after the sheet opens.
  // Move the initial focus only while the user is still on its fallback button.
  const fallback = document.activeElement;
  if (fallback instanceof HTMLElement && fallback.matches('[data-blok-database-drawer-close]') && !editorSlot.closest('[data-desktop-read-only]')) {
    const followTitle = (): void => {
      if (closed || disposed || document.activeElement !== fallback) { stopWatchingFocus(); return; }
      const title = editorSlot.querySelector<HTMLElement>('[data-blok-testid="page-header-title"]');
      if (title?.isContentEditable && !title.closest('[inert], [data-blok-loading]')) {
        title.focus({preventScroll: true});
      }
    };
    focusObserver = new MutationObserver(followTitle);
    focusObserver.observe(editorSlot, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-blok-loading', 'contenteditable', 'inert'],
    });
    document.addEventListener('focusin', stopWatchingFocus);
    followTitle();
  }
  return {
    setNeighbors(hasPrevious: boolean, hasNext: boolean) {
      previous = hasPrevious && !!options.onPrevious;
      next = hasNext && !!options.onNext;
      drawer.syncStepButtons();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      drawer.destroy();
      restore(); origin.remove();
    },
  };
}
