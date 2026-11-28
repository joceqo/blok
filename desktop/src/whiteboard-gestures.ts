import type { BoardTool } from './whiteboard-dock';
import { readBoardElement, type BoardElement } from './whiteboard-element';

interface GestureOptions {
  ink: (tool: DrawTool) => Pick<BoardElement, 'color' | 'strokeWidth'>;
  viewport: HTMLElement;
  world: HTMLElement;
  getTool: () => BoardTool;
  getZoom: () => number;
  panBy: (dx: number, dy: number) => void;
  editable: () => boolean;
  onSelect: (ids: Iterable<string>) => void;
  selected: () => ReadonlySet<string>;
  moveSelected: (dx: number, dy: number) => void;
  create: (item: BoardElement) => void;
  update: (id: string, patch: Partial<BoardElement>) => void;
  remove: (ids: Iterable<string>) => void;
  edit: (id: string) => void;
  onFinish: () => void;
}

type Point = { x: number; y: number };
type DrawTool = Exclude<BoardTool, 'hand' | 'select' | 'eraser'>;
interface Hit {
  id: string;
  wrapper: HTMLElement;
}

const svgNS = 'http://www.w3.org/2000/svg';
const sourceSelector = '[data-board-source-id]';
const objectSelector = '[data-blok-id][data-board-projection]';

function drawing(tool: DrawTool, start: Point, end: Point, dragged: boolean, stroke: Point[]): BoardElement {
  if (tool === 'pen' || tool === 'arrow') {
    let points: Point[];
    if (tool === 'arrow') {
      points = [start, dragged ? end : { x: start.x + 128, y: start.y }];
    } else {
      points = stroke.length > 1 ? stroke : [start, { x: start.x + 0.1, y: start.y }];
    }
    let left = start.x, top = start.y, right = start.x, bottom = start.y;
    for (const p of points) {
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
    return { kind: tool, x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top),
      points: points.map(p => [p.x - left, p.y - top]) };
  }

  const sizes = { note: [220, 152], text: [200, 56], rectangle: [152, 96], ellipse: [152, 96],
    diamond: [128, 108], frame: [480, 300], link: [240, 72] };
  const [w, h] = sizes[tool];
  return dragged
    ? { kind: tool, x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      w: Math.max(20, Math.abs(end.x - start.x)), h: Math.max(20, Math.abs(end.y - start.y)) }
    : { kind: tool, ...start, w, h };
}

function previewPath(item: BoardElement): string {
  const { kind, x, y, w, h } = item;
  if (kind === 'ellipse') return `M ${x},${y+h/2} a ${w/2},${h/2} 0 1 0 ${w},0 a ${w/2},${h/2} 0 1 0 ${-w},0 Z`;
  if (kind === 'diamond') return `M ${x+w/2},${y} L ${x+w},${y+h/2} ${x+w/2},${y+h} ${x},${y+h/2} Z`;
  if ((kind === 'pen' || kind === 'arrow') && item.points?.length) {
    const points = item.points.map(([dx, dy]) => [x + dx, y + dy]);
    let path = 'M ' + points.map(p => p.join(',')).join(' ');
    if (kind === 'arrow' && points.length >= 2) {
      const [[sx, sy], [ex, ey]] = points;
      const angle = Math.atan2(ey - sy, ex - sx);
      const wing = (delta: number) => `${ex - 10 * Math.cos(angle + delta)},${ey - 10 * Math.sin(angle + delta)}`;
      path += ` M ${wing(-0.5)} L ${ex},${ey} ${wing(0.5)}`;
    }
    return path;
  }
  return `M ${x},${y} h ${w} v ${h} h ${-w} Z`;
}

export function mountBoardGestures(options: GestureOptions): () => void {
  const { viewport, world } = options;
  const doc = world.ownerDocument;
  const win = doc.defaultView!;
  const overlay = doc.createElementNS(svgNS, 'svg');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.dataset.boardDraft = '';
  overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:2147483646;color:var(--desktop-accent,#4285dc)';
  const outline = doc.createElementNS(svgNS, 'path');
  outline.setAttribute('stroke', 'currentColor');
  outline.setAttribute('stroke-width', '2');
  outline.setAttribute('stroke-linecap', 'round');
  outline.setAttribute('stroke-linejoin', 'round');
  outline.setAttribute('vector-effect', 'non-scaling-stroke');
  overlay.append(outline);

  type Gesture = {
    pointer: number; tool: BoardTool; start: Point; client: Point; dragged: boolean;
    endpoint?: 'start' | 'end';
    marquee?: { previous: Set<string>; additive: boolean; boxes: Map<string, BoardElement> };
    groupDrag?: boolean;
    hit: Hit | null; box?: BoardElement; stroke: Point[]; erased: Map<string, Animation | undefined>;
  };
  let gesture: Gesture | null = null;
  let suppressClick = false;

  function position(event: PointerEvent): Point {
    const rect = world.getBoundingClientRect();
    const zoom = options.getZoom();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  }

  function hitTest(target: EventTarget | null): Hit | null {
    if (!(target instanceof Element) || !world.contains(target)) return null;
    const projection = target.closest<HTMLElement>(objectSelector);
    if (projection?.dataset.blokId) return { id: projection.dataset.blokId, wrapper: projection };
    const source = target.closest<HTMLElement>(sourceSelector);
    if (source?.dataset.boardSourceId) return { id: source.dataset.boardSourceId, wrapper: source };
    return null;
  }

  function hitAt(event: PointerEvent) {
    const target = doc.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
    return hitTest(target);
  }

  function bounds(hit: Hit): BoardElement {
    const item = hit.wrapper.matches(sourceSelector) ? undefined : readBoardElement(hit.wrapper);
    if (item && (item.kind !== 'arrow' || (!item.from && !item.to))) return item;
    const rect = hit.wrapper.getBoundingClientRect();
    const origin = world.getBoundingClientRect();
    const zoom = options.getZoom();
    const box = { x: (rect.left - origin.left) / zoom, y: (rect.top - origin.top) / zoom, w: rect.width / zoom, h: rect.height / zoom };
    if (item) {
      // Attached arrows follow their objects. Picking the line up detaches the displayed endpoints.
      const line = hit.wrapper.querySelector<SVGSVGElement>('svg[data-board-start][data-board-end]');
      const points = line ? [line.dataset.boardStart!, line.dataset.boardEnd!].map(pair => pair.split(',').map(Number)) : item.points;
      return { ...item, ...box, points };
    }
    return { kind: 'document', ...box };
  }

  function moved(box: BoardElement, start: Point, end: Point) {
    return { ...box, x: box.x + end.x - start.x, y: box.y + end.y - start.y };
  }

  function draw(active: Gesture, tool: DrawTool, end: Point) {
    const shape = drawing(tool, active.start, end, active.dragged, active.stroke);
    return { ...shape, ...options.ink(tool) };
  }

  function reshapeArrow(box: BoardElement, endpoint: 'start' | 'end', end: Point) {
    const points = box.points ?? [[0, 0], [box.w, box.h]];
    const opposite = endpoint === 'start' ? points[points.length - 1] : points[0];
    const fixed = { x: box.x + opposite[0], y: box.y + opposite[1] };
    return endpoint === 'start' ? drawing('arrow', end, fixed, true, []) : drawing('arrow', fixed, end, true, []);
  }

  function preview(item: BoardElement) {
    if (!overlay.parentNode) world.append(overlay);
    outline.style.color = item.color ?? (item.kind === 'pen' ? 'var(--desktop-ink, CanvasText)' : '');
    outline.setAttribute('stroke-width', String(item.strokeWidth ?? 2));
    outline.setAttribute('fill', item.kind === 'arrow' || item.kind === 'pen' ? 'none' : 'currentColor');
    outline.setAttribute('fill-opacity', '0.09');
    outline.setAttribute('d', previewPath(item));
  }

  function markErased(active: Gesture, hit: Hit | null) {
    if (!hit || hit.wrapper.matches(sourceSelector) || active.erased.has(hit.id)) return;
    const fade = hit.wrapper.animate?.([{ opacity: 0.3 }, { opacity: 0.3 }], { duration: 1000, iterations: Infinity });
    active.erased.set(hit.id, fade);
  }

  function clear() {
    const active = gesture;
    gesture = null;
    overlay.remove();
    world.style.removeProperty('--board-drag-offset');
    for (const fade of active?.erased.values() ?? []) fade?.cancel();
    if (active && viewport.hasPointerCapture?.(active.pointer)) viewport.releasePointerCapture(active.pointer);
  }

  function intercept(event: Event) {
    event.preventDefault();
    event.stopPropagation();
  }

  let spaceHeld = false;
  function spaceDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && gesture) {
      intercept(event);
      discard();
      return;
    }
    if (event.code !== 'Space' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('input, textarea, [contenteditable=true], button, a, select')) return;
    if (!viewport.contains(target) && !(target === doc.body && viewport.matches(':hover'))) return;
    intercept(event);
    spaceHeld = true;
    viewport.dataset.boardHand = '';
  }
  function releaseSpace() {
    spaceHeld = false;
    delete viewport.dataset.boardHand;
  }
  function spaceUp(event: KeyboardEvent) {
    if (event.code === 'Space') releaseSpace();
  }
  function discard() {
    if (gesture?.marquee) options.onSelect(gesture.marquee.previous);
    clear();
  }
  function blur() {
    discard();
    releaseSpace();
  }

  function down(event: PointerEvent) {
    if (gesture || event.button > 1 || event.isPrimary === false) return;
    suppressClick = false;
    let tool = event.button === 1 || spaceHeld ? 'hand' : options.getTool();
    const hit = hitTest(event.target);
    if (event.target instanceof Element && event.target.closest('textarea.blok-board-field')) return;
    if (tool === 'select') {
      if (hit?.wrapper.hasAttribute('data-board-editing')) return;
      if (event.target instanceof Element && event.target.closest('a[href]') &&
          (hit?.wrapper.matches(objectSelector) || !options.editable())) return;
    } else if (tool !== 'hand' && !options.editable()) {
      return;
    }
    if (tool === 'select' && !hit && event.pointerType === 'touch') tool = 'hand';
    intercept(event);
    suppressClick = true;
    viewport.focus({ preventScroll: true });
    const start = position(event);
    gesture = {
      pointer: event.pointerId, tool, start, client: { x: event.clientX, y: event.clientY }, dragged: false,
      hit, stroke: [start], erased: new Map(),
    };
    if (tool === 'select') {
      const previous = new Set(options.selected());
      if (!hit) {
        const boxes = new Map<string, BoardElement>();
        for (const node of world.querySelectorAll<HTMLElement>(objectSelector + ',' + sourceSelector)) {
          const candidate = hitTest(node);
          if (candidate) boxes.set(candidate.id, bounds(candidate));
        }
        gesture.marquee = { previous, additive: event.shiftKey, boxes };
        if (!event.shiftKey) options.onSelect([]);
        viewport.setPointerCapture?.(event.pointerId);
        return;
      }
      if (event.shiftKey) {
        if (previous.has(hit.id)) previous.delete(hit.id);
        else previous.add(hit.id);
        options.onSelect(previous);
      } else if (!previous.has(hit.id)) {
        options.onSelect([hit.id]);
      }
      if (options.selected().has(hit.id)) gesture.box = bounds(hit);
      gesture.groupDrag = options.selected().size > 1;
      const endpoint = event.target instanceof SVGElement ? event.target.getAttribute('data-board-endpoint') : null;
      if (!gesture.groupDrag && (endpoint === 'start' || endpoint === 'end')) gesture.endpoint = endpoint;
      // Leave two stationary clicks targeted at the original note for native dblclick.
      return;
    }
    viewport.setPointerCapture?.(event.pointerId);
    if (tool === 'eraser') markErased(gesture, hit);
  }

  function track(active: Gesture, event: PointerEvent) {
    const dx = event.clientX - active.client.x, dy = event.clientY - active.client.y;
    if (Math.hypot(dx, dy) >= 3) active.dragged = true;
    if (active.tool === 'hand') {
      options.panBy(dx, dy);
      active.client = { x: event.clientX, y: event.clientY };
      return;
    }
    const end = position(event);
    if (active.marquee) {
      if (!active.dragged) return;
      const x = Math.min(active.start.x, end.x), y = Math.min(active.start.y, end.y);
      const right = Math.max(active.start.x, end.x), bottom = Math.max(active.start.y, end.y);
      preview({ kind: 'rectangle', x, y, w: right - x, h: bottom - y, strokeWidth: 1, color: 'var(--board-selection)' });
      const ids = new Set(active.marquee.additive ? active.marquee.previous : []);
      for (const [id, box] of active.marquee.boxes) {
        if (box.x <= right && box.x + box.w >= x && box.y <= bottom && box.y + box.h >= y) ids.add(id);
      }
      const selected = options.selected();
      if (ids.size !== selected.size || [...ids].some(id => !selected.has(id))) options.onSelect(ids);
      return;
    }
    if (!options.editable()) return;
    if (active.tool === 'eraser') {
      markErased(active, hitAt(event));
      return;
    }
    if (active.tool === 'select') {
      if (active.dragged && active.box) {
        if (!viewport.hasPointerCapture?.(event.pointerId)) viewport.setPointerCapture?.(event.pointerId);
        if (active.endpoint) preview(reshapeArrow(active.box, active.endpoint, end));
        else world.style.setProperty('--board-drag-offset', `${end.x - active.start.x}px ${end.y - active.start.y}px`);
      }
      return;
    }
    if (active.tool === 'pen') {
      const last = active.stroke[active.stroke.length - 1];
      if (end.x !== last.x || end.y !== last.y) active.stroke.push(end);
    }
    if (active.dragged || active.tool === 'pen') preview(draw(active, active.tool, end));
  }

  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    intercept(event);
    track(gesture, event);
  }

  function up(event: PointerEvent) {
    const active = gesture;
    if (!active || event.pointerId !== active.pointer) return;
    intercept(event);
    const end = position(event);
    track(active, event);
    const endHit = active.tool === 'arrow' ? hitAt(event) : null;
    clear();
    if (!options.editable() || active.tool === 'hand') return;
    if (active.tool === 'select') {
      if (active.hit && active.box && active.dragged) {
        if (active.groupDrag) {
          options.moveSelected(end.x - active.start.x, end.y - active.start.y);
          return;
        }
        if (active.endpoint) {
          const target = hitAt(event);
          const id = target?.id !== active.hit.id ? target?.id : undefined;
          const attachment = active.endpoint === 'start' ? 'from' : 'to';
          options.update(active.hit.id, { ...reshapeArrow(active.box, active.endpoint, end), [attachment]: id });
          return;
        }
        const { x, y } = moved(active.box, active.start, end);
        const box = active.box;
        const patch: Partial<BoardElement> = { x, y };
        if (box.kind === 'arrow' && (box.from || box.to)) {
          Object.assign(patch, { w: box.w, h: box.h, points: box.points, from: undefined, to: undefined });
        }
        options.update(active.hit.id, patch);
      }
    } else if (active.tool === 'eraser') {
      options.remove(active.erased.keys());
    } else {
      const item = draw(active, active.tool, end);
      if (active.tool === 'arrow') {
        if (active.hit) item.from = active.hit.id;
        if (active.dragged && endHit && endHit.id !== item.from) item.to = endHit.id;
      }
      options.create(item);
      options.onFinish();
    }
  }

  function cancel(event: PointerEvent) {
    if (event.type === 'lostpointercapture' && event.target !== viewport) return;
    if (gesture?.pointer === event.pointerId) discard();
  }

  function click(event: MouseEvent) {
    if (suppressClick && event.detail > 0) intercept(event);
    suppressClick = false;
  }

  function doubleClick(event: MouseEvent) {
    if (options.getTool() !== 'select' || !options.editable()) return;
    const hit = hitTest(event.target);
    if (!hit || hit.wrapper.hasAttribute('data-board-editing')) return;
    intercept(event);
    options.edit(hit.id);
    if (hit.wrapper.matches(sourceSelector)) {
      const target = doc.elementFromPoint?.(event.clientX, event.clientY);
      const field = target?.closest<HTMLElement>('[contenteditable=true]') ??
        hit.wrapper.querySelector<HTMLElement>('[contenteditable=true]');
      field?.focus({ preventScroll: true });
      const point = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
      if (field && point && field.contains(point.offsetNode)) doc.getSelection()?.collapse(point.offsetNode, point.offset);
    }
  }

  viewport.addEventListener('pointerdown', down, true);
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('pointercancel', cancel, true);
  viewport.addEventListener('lostpointercapture', cancel);
  viewport.addEventListener('click', click, true);
  viewport.addEventListener('dblclick', doubleClick, true);
  doc.addEventListener('keydown', spaceDown, true);
  doc.addEventListener('keyup', spaceUp, true);
  win.addEventListener('blur', blur);
  return () => {
    clear();
    viewport.removeEventListener('pointerdown', down, true);
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', up, true);
    doc.removeEventListener('pointercancel', cancel, true);
    viewport.removeEventListener('lostpointercapture', cancel);
    viewport.removeEventListener('click', click, true);
    viewport.removeEventListener('dblclick', doubleClick, true);
    doc.removeEventListener('keydown', spaceDown, true);
    doc.removeEventListener('keyup', spaceUp, true);
    win.removeEventListener('blur', blur);
  };
}
