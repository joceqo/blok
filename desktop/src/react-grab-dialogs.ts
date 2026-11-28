/** Keep the inspector and its temporary clipboard focus within the modal interaction. */
export function attachGrabToDialogs(): () => void {
  let host: HTMLElement | null = null;
  const modalSelector = 'dialog:modal, [aria-modal="true"]';

  const sync = () => {
    // The inspector can mount after init or leave the document with a closing dialog.
    host = document.querySelector<HTMLElement>('[data-react-grab]') ?? host;
    if (!host) return;
    const surfaces = [...document.querySelectorAll<HTMLElement>(modalSelector)]
      .filter(surface => !surface.closest('[hidden], [inert], [aria-hidden="true"]'));
    const parent = surfaces.at(-1) ?? document.body;
    if (host.parentElement !== parent) parent.append(host);
    if (parent !== document.body) {
      host.removeAttribute('inert');
      host.removeAttribute('aria-hidden');
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'open']});

  const clipboardFocus = (event: FocusEvent) => {
    const entering = event.type === 'focusin';
    const field = entering ? event.target : event.relatedTarget;
    if (!(field instanceof HTMLTextAreaElement) || field.parentElement !== document.body ||
        field.getAttribute('aria-hidden') !== 'true' || !window.__REACT_GRAB__?.getState().isCopying) return;
    // React Grab selects an off-screen textarea for the duration of execCommand('copy').
    event.stopPropagation();
    const previous = event.relatedTarget;
    if (entering && previous instanceof HTMLElement) {
      queueMicrotask(() => {
        if (!field.isConnected && document.activeElement === document.body && previous.isConnected) {
          previous.focus({preventScroll: true});
        }
      });
    }
  };
  window.addEventListener('focusout', clipboardFocus, true);
  window.addEventListener('focusin', clipboardFocus, true);
  return () => {
    window.removeEventListener('focusin', clipboardFocus, true);
    window.removeEventListener('focusout', clipboardFocus, true);
    observer.disconnect();
  };
}
