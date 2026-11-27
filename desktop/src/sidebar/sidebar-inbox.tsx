import {shellText} from '../shell-i18n';
import { mountedElement } from './sidebar-elements';
import { inboxIconPath } from '../../../src/components/icons';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

export function mountSidebarInbox() {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.setAttribute('data-inbox-trigger', '');
  trigger.setAttribute('aria-expanded', 'false');
  const root = createRoot(trigger);
  flushSync(() =>
    root.render(
      <>
        <span aria-hidden="true">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d={inboxIconPath}
              stroke="currentColor"
              strokeWidth={1.4}
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span data-inbox-label="">{shellText("Notifications")}</span>
        <span
          data-inbox-count=""
          hidden
        />
      </>,
    ),
  );
  return {
    trigger,
    count: mountedElement(trigger.querySelector<HTMLElement>('[data-inbox-count]'), 'inbox count'),
    destroy: () => root.unmount(),
  };
}
