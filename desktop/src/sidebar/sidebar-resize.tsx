import {shellText} from '../shell-i18n';
import { useRef, useState, type PointerEvent } from 'react';

interface ResizeProps {
  width: number;
  collapsed: boolean;
  onWidth(width: number): void;
  onToggle(): void;
}

export const SidebarResize = ({ width, collapsed, onWidth, onToggle }: ResizeProps) => {
  const drag = useRef<{ id: number; x: number; y: number; left: number; moved: boolean } | null>(
    null,
  );
  const [resizing, setResizing] = useState(false);
  const [hintY, setHintY] = useState<number | null>(null);
  const resize = (value: number) => onWidth(Math.min(420, Math.max(220, value)));

  function move(event: PointerEvent<HTMLDivElement>) {
    setHintY(event.clientY - event.currentTarget.getBoundingClientRect().top);
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    // La marge de 4 px permet de cliquer sur la poignée même si le pointeur bouge un peu.
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    start.moved = true;
    setResizing(true);
    resize(event.clientX - start.left);
  }

  function clear() {
    drag.current = null;
    setResizing(false);
  }
  return (
    <div data-blok-sidebar-edge="">
      {/* biome-ignore lint/a11y/useSemanticElements: This focusable window splitter contains a drag handle and a tooltip. */}
      <div
        role="separator"
        tabIndex={0}
        aria-label={shellText("Redimensionner avec les flèches gauche et droite")}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={collapsed ? 0 : (width - 220) / 2}
        data-blok-sidebar-resize=""
        data-resizing={resizing ? '' : undefined}
        onPointerDown={(e) => {
          const shell = e.currentTarget.closest('[data-blok-shell]');
          if (e.button !== 0 || !shell) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const left = shell.getBoundingClientRect().left;
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left, moved: false };
        }}
        onPointerMove={move}
        onPointerLeave={() => setHintY(null)}
        onPointerUp={(e) => {
          if (drag.current?.id === e.pointerId && !drag.current.moved) onToggle();
          clear();
        }}
        onLostPointerCapture={clear}
        onPointerCancel={clear}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          resize(width + (e.key === 'ArrowRight' ? 16 : -16));
        }}
      >
        <span
          data-blok-sidebar-resize-anchor=""
          style={{ top: hintY ?? 0 }}
        />
        {hintY !== null && !resizing && (
          <span
            role="tooltip"
            className="sidebar-resize-tooltip"
            style={{ top: hintY }}
          >
            <span data-blok-sidebar-resize-hint="">
              <span>{collapsed ? shellText("Ouvrir") : shellText("Fermer")}</span>
              <span>{shellText("Clic ou ⌘\\")}</span>
              <span>{shellText("Redimensionner")}</span>
              <span>{shellText("Glisser")}</span>
            </span>
          </span>
        )}
      </div>
    </div>
  );
};
