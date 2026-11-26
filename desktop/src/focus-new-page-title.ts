export function focusNewPageTitle(holder: HTMLElement): () => void {
  // The collaborative editor can mount the title before granting editability.
  const opener = document.activeElement;
  let frame = 0;
  const stopFocusing = (): void => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    size.disconnect();
  };
  const focusTitle = (): void => {
    frame = 0;
    const title = holder.querySelector<HTMLElement>('[data-blok-page-title][contenteditable="true"]');
    if (!title?.isConnected) return;
    if (document.activeElement !== opener && document.activeElement !== document.body) {
      stopFocusing();
      return;
    }
    size.observe(title);
    if (!title.getClientRects().length) return;
    title.focus();
    if (document.activeElement === title) {
      window.getSelection()?.selectAllChildren(title);
      stopFocusing();
    }
  };
  const scheduleFocus = (): void => { if (!frame) frame = requestAnimationFrame(focusTitle); };
  const observer = new MutationObserver(scheduleFocus);
  const size = new ResizeObserver(scheduleFocus);
  observer.observe(holder, {subtree: true, childList: true, attributes: true,
    attributeFilter: ['contenteditable', 'class', 'hidden', 'style']});
  scheduleFocus();
  return stopFocusing;
}
