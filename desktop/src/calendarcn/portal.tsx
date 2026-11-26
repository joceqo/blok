import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const CalendarPortalHost = createContext<HTMLElement | undefined>(undefined);
export const useCalendarPortalHost = () => useContext(CalendarPortalHost);

function ScopedPortal({children, target}: {children: ReactNode; target: Element | DocumentFragment}) {
  const host = useCalendarPortalHost();
  return createPortal(children, target === document.body && host ? host : target);
}

export function createCalendarPortal(children: ReactNode, target: Element | DocumentFragment, key?: string | null) {
  return <ScopedPortal key={key} target={target}>{children}</ScopedPortal>;
}
