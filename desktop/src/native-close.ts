type CloseBridge = {invoke(command: string, args?: Record<string, unknown>): Promise<unknown>};

/** Arm only once a renderer can save. The gateway and startup screen can close directly. */
export async function guardNativeClose(host: HTMLElement, bridge: CloseBridge, flush: () => Promise<void>): Promise<void> {
  let closing = false;
  let notice: HTMLElement | undefined;
  function message(text: string, failed: boolean): void {
    notice ??= document.createElement('div');
    notice.className = 'desktop-close-notice';
    notice.setAttribute('role', failed ? 'alert' : 'status');
    notice.textContent = text;
    document.body.append(notice);
  }
  async function prepare(): Promise<void> {
    if (closing) return;
    closing = true;
    notice?.remove();
    const previous = host.inert;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    host.inert = true;
    const timer = setTimeout(() => message('Enregistrement des dernières modifications…', false), 250);
    try {
      await flush();
      await bridge.invoke('finish_editor_close', {saved: true});
    } catch (error) {
      clearTimeout(timer);
      host.inert = previous;
      const detail = error instanceof Error ? error.message : String(error);
      message('Impossible de terminer l’enregistrement. Votre espace reste ouvert. ' + detail, true);
      try { await bridge.invoke('finish_editor_close', {saved: false}); }
      finally { closing = false; }
    } finally { clearTimeout(timer); }
  }
  const onClose = (): void => { void prepare().catch(console.error); };
  window.addEventListener('blok:desktop-prepare-close', onClose);
  try { await bridge.invoke('arm_editor_close'); }
  catch (error) {
    window.removeEventListener('blok:desktop-prepare-close', onClose);
    throw error;
  }
}
