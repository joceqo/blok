// Install before the shell boots so a stuck startup screen remains inspectable.
window.addEventListener('keydown', event => {
  if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || event.code !== 'KeyI') return;
  // Let editable controls and the rich-text editor handle their own italic command.
  if (event.composedPath().some(node => node instanceof HTMLElement &&
    (node.isContentEditable || node.matches('input, textarea, [role="textbox"]')))) return;

  event.preventDefault();
  if (!event.repeat) window.__TAURI_INTERNALS__.invoke('plugin:webview|internal_toggle_devtools');
}, true);
