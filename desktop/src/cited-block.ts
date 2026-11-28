import type { BlockAPI } from '../../types';

/** Ce que la navigation vers un bloc cité demande à un éditeur de page. */
export interface CitedBlockEditor {
  isReady: Promise<unknown>;
  blocks: { getById(id: string): Pick<BlockAPI, 'holder'> | null };
  caret: { setToBlock(id: string, position?: 'start'): boolean };
}

export interface CitedBlockHost {
  /** Ouvre la page : la navigation du shell, qui monte l'éditeur plus tard. */
  navigate(pageId: string): void;
  /** L'éditeur déjà monté pour cette page, lorsqu'elle est déjà ouverte. */
  mountedEditor(pageId: string): CitedBlockEditor | null;
  /** Compteur de navigation : il change dès que le lecteur part ailleurs. */
  generation(): number;
  /** Remote blocks may arrive after isReady. */
  remoteCanvas?: HTMLElement;
}

export interface CitedBlockNavigator {
  /** Une source citée dans le panneau IA : sa page, et le bloc à montrer. */
  open(pageId: string, blockId?: string): void;
  /** À appeler quand l'éditeur d'une page vient d'être monté. */
  pageMounted(pageId: string, editor: CitedBlockEditor): void;
}

/**
 * Cliquer une source citée ouvre sa page et amène le lecteur jusqu'au bloc cité.
 * La page s'ouvre de façon asynchrone : la citation attend donc le montage de
 * son éditeur, sauf quand elle désigne la page déjà affichée.
 */
export function createCitedBlockNavigator(host: CitedBlockHost): CitedBlockNavigator {
  const pending: { citation: { pageId: string; blockId: string } | null } = { citation: null };

  let request = 0;
  let stopWaiting: (() => void) | undefined;
  const reveal = (editor: CitedBlockEditor, blockId: string): void => {
    const turn = host.generation();
    const currentRequest = request;
    void editor.isReady.then(() => {
      // Le lecteur est reparti ailleurs pendant le chargement : ne pas le déplacer.
      const tryScroll = (): boolean => {
        if (host.generation() !== turn || request !== currentRequest) return true;
        const block = editor.blocks.getById(blockId);
        if (!block) return false;
        editor.caret.setToBlock(blockId, 'start');
        block.holder.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return true;
      };
      if (tryScroll() || !host.remoteCanvas) return;
      const observer = new MutationObserver(() => { if (tryScroll()) finish(); });
      const finish = (): void => {
        observer.disconnect();
        clearTimeout(timer);
        if (stopWaiting === finish) stopWaiting = undefined;
      };
      const timer = setTimeout(finish,30_000);
      stopWaiting = finish;
      observer.observe(host.remoteCanvas,{subtree:true,childList:true});
    }).catch(() => { /* The workspace handles editor mount errors. */ });
  };

  return {
    open(pageId, blockId) {
      request++;
      stopWaiting?.();
      const mounted = blockId ? host.mountedEditor(pageId) : null;
      pending.citation = blockId && !mounted ? { pageId, blockId } : null;
      host.navigate(pageId);
      if (blockId && mounted) reveal(mounted, blockId);
    },
    pageMounted(pageId, editor) {
      const { citation } = pending;
      pending.citation = null;
      if (citation?.pageId === pageId) reveal(editor, citation.blockId);
    },
  };
}
