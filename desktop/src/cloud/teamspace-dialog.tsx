import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {openModalDialog} from '@blok/modal-dialog';
import {IconCross} from '../../../src/components/icons';

export function TeamspaceDialog({title, variant, children, onClose, busy = false}: {
  title: string; variant: 'editor' | 'invite' | 'detail'; children: ReactNode; onClose(): void; busy?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const blocked = useRef(busy);
  blocked.current = busy;
  const [surface] = useState(() => document.createElement('section'));
  useLayoutEffect(() => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-desktop-settings-overlay', '');
    overlay.className = 'teamspace-overlay';
    surface.className = 'teamspace-dialog teamspace-dialog-' + variant;
    surface.tabIndex = -1;
    overlay.append(surface);
    const handle = openModalDialog({content: overlay, surface, label: title,
      container: anchor.current?.closest<HTMLElement>('[data-desktop-settings-dialog]') ?? undefined,
      initialFocus: () => surface.querySelector<HTMLElement>('[data-initial-focus]') ?? surface,
      onDismiss: () => {if (!blocked.current) close.current();},
    });
    return () => handle.close();
  }, [surface, variant]);
  useLayoutEffect(() => {surface.setAttribute('aria-label', title);}, [surface, title]);
  return <><span ref={anchor} hidden/>{createPortal(<>
    <button type="button" className="teamspace-close" aria-label="Fermer la fenêtre" disabled={busy} onClick={onClose} dangerouslySetInnerHTML={{__html: IconCross}}/>
    {children}
  </>, surface)}</>;
}

export function Alert({message, retry}: {message?: string; retry?: () => void}) {
  return message ? <p className="teamspace-error" role="alert">{message} {retry && <button onClick={retry}>Réessayer</button>}</p> : null;
}
