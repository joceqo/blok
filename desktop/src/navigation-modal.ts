import { openModalDialog, type ModalDialogHandle } from '@blok/modal-dialog';
import { IconCross } from '../../src/components/icons';

export function createNavigationDialog(label: string): {
  surface: HTMLElement;
  open: (focus: HTMLElement, cleanup?: () => void) => void;
  close: () => void;
} {
  const overlay = document.createElement('div');
  const surface = document.createElement('div');
  const closeButton = document.createElement('button');
  overlay.setAttribute('data-desktop-settings-overlay', '');
  surface.setAttribute('data-navigation-dialog', '');
  closeButton.setAttribute('data-navigation-close', '');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Fermer');
  closeButton.innerHTML = IconCross;
  surface.tabIndex = -1;
  surface.append(closeButton);
  overlay.append(surface);
  let handle: ModalDialogHandle | null = null;
  const close = (): void => handle?.close();
  closeButton.addEventListener('click', close);
  return {
    surface,
    close,
    open(focus, cleanup) {
      handle = openModalDialog({
        content: overlay,
        surface,
        label,
        initialFocus: () => focus,
        onDismiss: close,
        onClose: cleanup,
      });
    },
  };
}
