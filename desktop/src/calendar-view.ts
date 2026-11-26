import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { CalendarStore } from './calendar-store';
import type { CalendarWorkspaces } from './calendar-workspaces';
import type { WorkspaceRef } from './workspace-registry';
import { BlokCalendar } from './calendar-app-blok';

export interface CalendarOptions {
  store: CalendarStore;
  pages: Array<{ id: string; title: string }>;
  openPage(id: string): void;
  workspaces?: CalendarWorkspaces;
  openWorkspacePage?(ref: WorkspaceRef, id: string): void;
  canEdit: boolean;
  onClose(): void;
  onToggleSidebar?(): void;
}

export function mountCalendar(host: HTMLElement, options: CalendarOptions) {
  const container = document.createElement('div');
  container.className = 'blok-calendarcn blok-calendar';
  host.append(container);
  const root = createRoot(container);
  root.render(createElement(BlokCalendar, {options, container}));
  return { destroy() { root.unmount(); container.remove(); } };
}
