import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {openModalDialog} from '@blok/modal-dialog';

type Shortcut = [label: string, keys: string[]];

function ShortcutGroup({title, shortcuts}: {title: string; shortcuts: Shortcut[]}) {
  return <section data-shortcut-group="">
    <h3>{title}</h3>
    <dl>{shortcuts.map(([label, keys]) => <div key={label}>
      <dt>{label}</dt>
      <dd>{keys.map(key => <kbd key={key}>{key}</kbd>)}</dd>
    </div>)}</dl>
  </section>;
}

export function showShortcutsDialog(): void {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const navigation: Shortcut[] = [
    ['Ouvrir les réglages', [mod, ',']], ['Rechercher une page', [mod, 'P']], ['Parcourir les résultats', ['↑', '↓']],
    ['Ouvrir le résultat', ['Entrée']], ['Fermer le volet actif', ['Échap']],
  ];
  const editing: Shortcut[] = [
    ['Insérer un bloc', ['/']], ['Imbriquer le bloc', ['Tab']], ['Désimbriquer le bloc', ['Maj', 'Tab']], ['Mentionner une page ou une date', ['@']], ['Annuler', [mod, 'Z']],
  ];
  const overlay = document.createElement('div');
  overlay.setAttribute('data-desktop-settings-overlay', '');
  overlay.setAttribute('data-desktop-shortcuts-dialog', '');
  const surface = document.createElement('section');
  surface.setAttribute('data-desktop-shortcuts-surface', '');
  overlay.append(surface);
  const root = createRoot(surface);
  flushSync(() => root.render(<>
    <header><h2>Raccourcis Blok</h2><button type="button" aria-label="Fermer les raccourcis" onClick={() => dialog.close()}>×</button></header>
    <ShortcutGroup title="Navigation" shortcuts={navigation}/>
    {'__TAURI_INTERNALS__' in window && <ShortcutGroup title="Onglets" shortcuts={[
      ['Nouvel onglet', [mod, 'T']], ['Recharger l’onglet', [mod, 'R']], ['Fermer l’onglet', [mod, 'W']],
    ]}/>}
    <ShortcutGroup title="Éditeur" shortcuts={editing}/>
  </>));
  const dialog = openModalDialog({
    content:overlay, surface, label:'Raccourcis Blok',
    initialFocus: () => surface.querySelector('button'),
    onDismiss: () => dialog.close(),
    onClose: () => root.unmount(),
  });
}
