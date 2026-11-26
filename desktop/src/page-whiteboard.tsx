import { createRoot } from 'react-dom/client';
import { openBoardSurface } from './whiteboard-scene';
import './page-whiteboard.css';

export { whiteboardPlacementTune } from './whiteboard-placement';

type View = 'document' | 'whiteboard';
interface Options {
  holder: HTMLElement;
  controls: HTMLElement;
  getEditor: Parameters<typeof openBoardSurface>[1];
  assets?: Parameters<typeof openBoardSurface>[2];
  initialView?: View;
  onViewChange?: (view: View) => void;
}

export function mountPageWhiteboard({
  holder,
  controls,
  getEditor,
  assets,
  initialView = 'document',
  onViewChange,
}: Options) {
  controls.classList.add('blok-page-views');
  const root = createRoot(controls);
  let view: View = initialView;
  let board: ReturnType<typeof openBoardSurface> | undefined;
  function setView(next: View) {
    view = next;
    holder.dataset.pageView = next;
    if (next === 'whiteboard') board ??= openBoardSurface(holder, getEditor, assets);
    else {
      board?.destroy();
      board = undefined;
    }
    root.render(
      <div role="group" aria-label="Vue de la page" className="blok-page-view-switch">
        {(['document', 'whiteboard'] as const).map((mode) => {
          const label = mode === 'document' ? 'Document' : 'Tableau blanc';
          return (
            <button key={mode} type="button" aria-label={label} title={label}
              aria-pressed={view === mode} onClick={() => change(mode)}>
              <svg aria-hidden="true" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor"
                strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                {mode === 'document' ? <>
                  <rect x="3.5" y="2" width="13" height="16" rx="2.5" />
                  <path d="M7 6h6M7 9.5h6M7 13h3.5" />
                </> : <>
                  <path d="M4.5 2 7 4.5 4.5 7 2 4.5ZM7 4.5a9 9 0 0 1 9 9M4.5 7v6M7 15.5h6" />
                  <circle cx="4.5" cy="15.5" r="2.5" />
                  <rect x="13.5" y="13" width="4.5" height="5" rx="1" />
                </>}
              </svg>
            </button>
          );
        })}
      </div>,
    );
  }
  function change(next: View) {
    if (next === view) return;
    setView(next);
    onViewChange?.(next);
  }
  function onPlace() {
    change('whiteboard');
  }
  holder.addEventListener('blok:whiteboard-place', onPlace);
  setView(initialView);
  return {
    setView,
    refresh() {
      board?.refresh();
    },
    destroy() {
      holder.removeEventListener('blok:whiteboard-place', onPlace);
      board?.destroy();
      delete holder.dataset.pageView;
      root.unmount();
    },
    get view() {
      return view;
    },
  };
}
