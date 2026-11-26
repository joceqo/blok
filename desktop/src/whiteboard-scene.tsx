import { createRoot } from 'react-dom/client';
import type { API } from '../../types';
import { BoardDock, type BoardTool } from './whiteboard-dock';
import { bindBoardImageDrop } from './whiteboard-image-drop';
import { mountBoardGestures } from './whiteboard-gestures';
import {
  readBoardElement,
  renderBoardElement,
  renderBoardConnector,
  type BoardElement,
} from './whiteboard-element';

import { boardTemplate, frameSizes, type FrameFormat, type Template } from './whiteboard-options';

const sourceId = 'page-note';
const defaultNote: BoardElement = { kind: 'document', x: 56, y: 48, w: 560, h: 220 };
type Editor = Pick<API, 'blocks' | 'readOnly' | 'uploader'>;
type Box = Pick<BoardElement, 'x' | 'y' | 'w' | 'h'>;

function div(className: string) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
function position(node: HTMLElement, box: Box) {
  for (const key of ['x', 'y', 'w', 'h'] as const) node.style.setProperty('--board-' + key, box[key] + 'px');
}
const center = (r: Box) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
function edge(r: Box, toward: { x: number; y: number }) {
  const p = center(r);
  const dx = toward.x - p.x,
    dy = toward.y - p.y;
  const divisor = Math.max(Math.abs(dx) / Math.max(1, r.w / 2), Math.abs(dy) / Math.max(1, r.h / 2));
  return divisor ? { x: p.x + dx / divisor, y: p.y + dy / divisor } : p;
}

export function openBoardSurface(holder: HTMLElement, editor: () => Editor | null,
  assets?: {origin?: string; resolve(url: string): Promise<string>}) {
  const stage = div('blok-board-stage');
  const viewport = div('blok-board-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', 'Surface du tableau blanc');
  const world = div('blok-board-world');
  const dock = div('blok-board-overlay');
  const message = div('blok-board-message');
  message.setAttribute('role', 'status');
  const source = div('blok-board-page-note');
  source.dataset.boardSourceId = sourceId;
  source.tabIndex = 0;
  source.setAttribute('role', 'group');
  source.setAttribute('aria-label', 'Note du document');
  const wasInert = holder.inert;
  holder.before(stage);
  source.append(holder);
  world.append(source);
  viewport.append(world);
  stage.append(viewport, dock, message);
  const root = createRoot(dock);
  let tool: BoardTool = 'select';
  const colors = new Map<BoardTool, string>();
  const widths = new Map<BoardTool, number>();
  let initialFitPending = true;
  let zoom = 1;
  let originX = 0;
  let originY = 0;
  let selectedIds = new Set<string>();
  const groupBounds = div('blok-board-group-bounds');
  groupBounds.hidden = true;
  groupBounds.setAttribute('aria-hidden', 'true');
  world.append(groupBounds);
  function singleSelection() {
    return selectedIds.size === 1 ? [...selectedIds][0] : null;
  }
  let active = true;
  let animation = 0;
  let anchorId: string | undefined;
  let noteBox = defaultNote;
  let closeField: (() => void) | undefined;
  let lastReadonly: boolean | undefined;
  const objects = new Map<string, { item: BoardElement; node: HTMLElement; state: string }>();
  function editable() {
    const api = editor();
    return !!api && !api.readOnly.isEnabled && !holder.closest('[data-desktop-read-only]');
  }
  function warn() {
    if (active) message.textContent = 'La modification du tableau n’a pas pu être enregistrée.';
  }
  function select(id: string | null) {
    selectMany(id ? [id] : []);
  }
  function selectMany(ids: Iterable<string>) {
    selectedIds = new Set(ids);
    if (singleSelection() !== sourceId) source.removeAttribute('data-board-editing');
    holder.inert = editable() && !source.hasAttribute('data-board-editing');
    source.toggleAttribute('data-board-selected', selectedIds.has(sourceId));
    for (const [key, { node }] of objects) node.toggleAttribute('data-board-selected', selectedIds.has(key));
    groupBounds.hidden = selectedIds.size < 2;
    if (groupBounds.hidden) return;
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const key of selectedIds) {
      const node = key === sourceId ? source : objects.get(key)?.node;
      if (!node) continue;
      x = Math.min(x, node.offsetLeft);
      y = Math.min(y, node.offsetTop);
      right = Math.max(right, node.offsetLeft + node.offsetWidth);
      bottom = Math.max(bottom, node.offsetTop + node.offsetHeight);
    }
    position(groupBounds, { x, y, w: right - x, h: bottom - y });
  }
  function setTool(next: BoardTool) {
    if (!editable() && next !== 'select' && next !== 'hand') next = 'select';
    if (next !== 'select') select(null);
    tool = next;
    stage.dataset.boardTool = next;
    source.removeAttribute('data-board-editing');
    holder.inert = editable();
    drawDock();
  }
  function extent() {
    const bounds = [{ ...noteBox, h: source.offsetHeight }, ...Array.from(objects.values(), (o) => o.item)];
    return {
      left: Math.min(...bounds.map((b) => b.x)),
      top: Math.min(...bounds.map((b) => b.y)),
      right: Math.max(...bounds.map((b) => b.x + b.w)),
      bottom: Math.max(...bounds.map((b) => b.y + b.h)),
    };
  }
  // Camera coordinates are local to this view. Moving the viewport never moves a block.
  function paintCamera() {
    world.style.transform = `translate(${originX}px, ${originY}px) scale(${zoom})`;
    const step = zoom < 0.5 ? 2 : 1 / Math.max(1, Math.floor(zoom));
    const spacing = Math.round(Math.max(10, Math.min(50, 20 * step * zoom)));
    world.style.setProperty('--board-screen-pixel', `${1 / zoom}px`);
    viewport.style.backgroundSize = `${spacing}px ${spacing}px`;
    viewport.style.backgroundPosition = `${originX % spacing}px ${originY % spacing}px`;
  }
  function panBy(dx: number, dy: number) {
    initialFitPending = false;
    originX += dx;
    originY += dy;
    paintCamera();
  }
  function zoomAt(value: number, x: number, y: number) {
    initialFitPending = false;
    const next = Math.max(0.1, Math.min(3, value));
    if (next === zoom) return;
    const ratio = next / zoom;
    originX = x - (x - originX) * ratio;
    originY = y - (y - originY) * ratio;
    zoom = next;
    paintCamera();
    drawDock();
  }
  function changeZoom(action: 'in' | 'out' | 'fit') {
    initialFitPending = false;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (action !== 'fit') {
      zoomAt(zoom * (action === 'in' ? 1.25 : 0.8), width / 2, height / 2);
      return;
    }
    const b = extent();
    const fit = Math.min((width - 64) / Math.max(1, b.right - b.left),
      (height - 100) / Math.max(1, b.bottom - b.top));
    zoom = Math.max(0.1, Math.min(3, fit));
    originX = (width - (b.left + b.right) * zoom) / 2;
    originY = (height - 48 - (b.top + b.bottom) * zoom) / 2;
    paintCamera();
    drawDock();
  }
  function drawDock() {
    lastReadonly = !editable();
    root.render(
      <BoardDock tool={tool} onTool={setTool} zoom={zoom} onZoom={changeZoom} readOnly={lastReadonly}
        onFormat={placeFrame}
        color={colors.get(tool)} onColor={color => { colors.set(tool, color); drawDock(); }}
        strokeWidth={widths.get(tool) ?? (tool === 'arrow' ? 2.5 : 3)}
        onStrokeWidth={width => { widths.set(tool, width); drawDock(); }} onTemplate={placeTemplate} />,
    );
  }
  function connect() {
    const box = (id?: string) =>
      id === sourceId ? { ...noteBox, h: source.offsetHeight } : id ? objects.get(id)?.item : undefined;
    for (const { item, node } of objects.values()) {
      if (item.kind !== 'arrow' || (!item.from && !item.to)) continue;
      const a = box(item.from),
        b = box(item.to);
      const points = item.points ?? [
        [0, 0],
        [item.w, item.h],
      ];
      const first = points[0] ?? [0, 0],
        last = points.at(-1) ?? [item.w, item.h];
      const start = a ? center(a) : { x: item.x + first[0], y: item.y + first[1] };
      const end = b ? center(b) : { x: item.x + last[0], y: item.y + last[1] };
      renderBoardConnector(node, a ? edge(a, end) : start, b ? edge(b, start) : end);
    }
  }
  function sync() {
    if (!active) return;
    const seen = new Set<string>();
    anchorId = undefined;
    noteBox = defaultNote;
    for (const block of holder.querySelectorAll<HTMLElement>(
      '[data-blok-component="whiteboardElement"][data-blok-id]',
    )) {
      const id = block.dataset.blokId!;
      const original = block.querySelector<HTMLElement>('[data-board-element]');
      const state = original?.dataset.boardState;
      if (!state) continue;
      const prior = objects.get(id);
      if (prior?.state === state) {
        seen.add(id);
        continue;
      }
      const item = readBoardElement(block);
      if (!item) continue;
      if (item.kind === 'document') {
        // Two offline clients may both place the page for the first time.
        // Always pick the same anchor when those independently created blocks merge.
        if (!anchorId || id < anchorId) {
          anchorId = id;
          noteBox = item;
        }
        continue;
      }
      seen.add(id);
      const node = prior?.node ?? div('blok-board-object');
      node.dataset.blokId = id;
      node.dataset.boardProjection = '';
      node.dataset.kind = item.kind;
      node.tabIndex = 0;
      node.setAttribute('role', 'group');
      const reuseImage = item.kind === 'image' && prior?.item.kind === 'image' &&
        prior.item.url === item.url && prior.item.text === item.text;
      const content = reuseImage ? node.firstElementChild as HTMLElement : renderBoardElement(item, assets?.resolve);
      if (reuseImage) {
        // Keep the decoded bitmap, but hit tests must use its latest saved position.
        content.dataset.boardState = state;
        position(content, item);
      } else node.replaceChildren(content);
      node.setAttribute('aria-label', content.getAttribute('aria-label') || item.kind);
      position(node, item);
      if (!prior) world.append(node);
      objects.set(id, { item, node, state });
    }
    for (const [id, { node }] of objects)
      if (!seen.has(id)) {
        node.remove();
        objects.delete(id);
      }
    position(source, noteBox);
    connect();
    selectMany([...selectedIds].filter(id => id === sourceId || seen.has(id)));
    // A deep link can mount the board before the local load or first collaborative sync.
    if (initialFitPending && editor() && viewport.clientWidth && viewport.clientHeight &&
        !holder.querySelector('[data-blok-editor][aria-busy="true"]')) {
      changeZoom('fit');
    }
    if (lastReadonly !== !editable()) {
      if (!editable()) {
        closeField?.();
        setTool('select');
      } else drawDock();
    }
  }
  function schedule() {
    if (!animation)
      animation = requestAnimationFrame(() => {
        animation = 0;
        sync();
      });
  }
  function insert(item: BoardElement) {
    if (!editable()) return;
    const blocks = editor()!.blocks;
    const block = blocks.insert('whiteboardElement', item, {}, blocks.getBlocksCount(), false);
    schedule();
    return block.id;
  }
  async function update(id: string, patch: Partial<BoardElement>) {
    if (!editable()) return;
    try {
      if (id === sourceId && !anchorId) {
        anchorId = insert({ ...defaultNote, ...patch, kind: 'document' });
        return;
      }
      const key = id === sourceId ? anchorId! : id;
      if (!editor()!.blocks.getById(key)) return;
      await editor()!.blocks.update(key, patch);
      schedule();
    } catch {
      warn();
    }
  }
  async function moveSelected(dx: number, dy: number) {
    const changes = Array.from(selectedIds, id => {
      const box = id === sourceId ? noteBox : objects.get(id)?.item;
      return box && { id, x: box.x + dx, y: box.y + dy };
    });
    for (const change of changes) {
      if (!active || !editable()) return;
      if (change) await update(change.id, { x: change.x, y: change.y });
    }
  }
  async function remove(idsToRemove: Iterable<string>) {
    if (!editable()) return;
    const ids = new Set(idsToRemove);
    ids.delete(sourceId);
    const blocks = editor()!.blocks;
    for (const [id, { item }] of objects) {
      if ((item.from && ids.has(item.from)) || (item.to && ids.has(item.to))) ids.add(id);
    }
    try {
      for (const key of ids) {
        if (!active || !editable()) break;
        const i = blocks.getBlockIndex(key);
        if (i !== undefined && i >= 0) await blocks.delete(i, false);
      }
      schedule();
    } catch {
      warn();
    }
  }
  function editField(item: BoardElement, save: (value: string) => void) {
    closeField?.();
    const input = document.createElement('textarea');
    input.className = 'blok-board-field';
    input.setAttribute('aria-label', item.kind === 'link' ? 'Adresse du lien' : 'Texte de l’élément');
    input.placeholder = item.kind === 'link' ? 'https://…' : 'Écrire…';
    input.value = (item.kind === 'link' ? item.url : item.text) ?? '';
    const inline = item.kind !== 'link';
    const field = inline ? div('blok-board-inline-editor') : input;
    const selection = singleSelection();
    const original = selection ? objects.get(selection)?.node : undefined;
    if (inline) {
      position(field, item);
      const surface = renderBoardElement(item);
      surface.removeAttribute('role');
      surface.removeAttribute('aria-label');
      surface.querySelector('span')?.remove();
      input.classList.add('blok-board-inline-input');
      input.rows = 1;
      surface.append(input);
      field.append(surface);
      original?.setAttribute('data-board-field-open', '');
    } else {
      position(input, { ...item, w: Math.max(170, item.w), h: Math.max(48, Math.min(190, item.h)) });
    }
    world.append(field);
    function fitText() {
      if (!inline) return;
      input.style.height = '0px';
      input.style.height = input.scrollHeight + 'px';
    }
    fitText();
    input.addEventListener('input', fitText);
    let done = false;
    function finish(commit: boolean) {
      if (done) return;
      done = true;
      closeField = undefined;
      const value = input.value.trim();
      field.remove();
      original?.removeAttribute('data-board-field-open');
      if (commit && active && editable()) save(value);
    }
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      } else if (event.key === 'Enter' && (item.kind === 'link' || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    closeField = () => finish(false);
    input.focus();
    input.select();
  }
  function linkValue(value: string) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      /* An incomplete address stays off the board. */
    }
    if (value) message.textContent = 'Utilisez une adresse http ou https.';
  }
  function edit(id: string) {
    if (!editable()) return;
    select(id);
    if (id === sourceId) {
      source.setAttribute('data-board-editing', '');
      holder.inert = false;
      return;
    }
    const item = objects.get(id)?.item;
    if (!item || item.kind === 'image' || item.kind === 'pen' || item.kind === 'arrow') return;
    editField(item, (value) => {
      if (item.kind === 'link') {
        const url = linkValue(value);
        if (url) void update(id, { url });
      } else void update(id, { text: value });
    });
  }
  function placeFrame(format: FrameFormat) {
    if (!editable()) return;
    const size = frameSizes[format];
    if (!size) return;
    const [w, h] = size;
    create({ kind: 'frame', w, h, x: (viewport.clientWidth / 2 - originX) / zoom - w / 2,
      y: (viewport.clientHeight / 2 - originY) / zoom - h / 2 });
    setTool('select');
  }
  function placeTemplate(template: Template) {
    if (!editable()) return;
    const blocks = editor()!.blocks;
    try {
      const cx = (viewport.clientWidth / 2 - originX) / zoom;
      const cy = (viewport.clientHeight / 2 - originY) / zoom;
      const placed = blocks.insertMany(boardTemplate(template, cx, cy), blocks.getBlocksCount());
      sync();
      setTool('select');
      select(placed[0]?.id ?? null);
    } catch { warn(); }
  }
  function create(item: BoardElement) {
    if (!editable()) return;
    message.textContent = '';
    const add = (value: BoardElement) => {
      try {
        const id = insert(value);
        if (id) {
          sync();
          select(value.kind === 'pen' ? null : id);
        }
      } catch {
        warn();
      }
    };
    if (item.kind === 'link')
      editField(item, (value) => {
        const url = linkValue(value);
        if (url) add({ ...item, url });
      });
    else {
      add(item);
      const selection = singleSelection();
      if (selection && (item.kind === 'note' || item.kind === 'text')) edit(selection);
    }
  }
  const unbindDrop = bindBoardImageDrop({
    viewport, world, zoom: () => zoom, writable: editable, uploader: () => editor()?.uploader,
    assetOrigin: assets?.origin,
    place(item) {
      const id = insert(item);
      sync();
      setTool('select');
      select(id ?? null);
      viewport.focus({preventScroll:true});
    },
    status(text) { message.textContent = text; },
  });
  const unbind = mountBoardGestures({
    viewport,
    world,
    getTool: () => tool,
    getZoom: () => zoom,
    ink: tool => ({
      ...(colors.has(tool) && { color: colors.get(tool) }),
      ...(widths.has(tool) && { strokeWidth: widths.get(tool) }),
    }),
    panBy,
    editable,
    selected: () => selectedIds,
    onSelect: selectMany,
    moveSelected,
    create,
    update,
    remove,
    edit,
    onFinish: () => {
      if (tool !== 'pen') setTool('select');
    },
  });
  let pinchStartZoom: number | undefined;
  function wheel(e: WheelEvent) {
    const pinch = e.ctrlKey || e.metaKey;
    if (!pinch && e.target instanceof HTMLTextAreaElement && e.target.scrollHeight > e.target.clientHeight) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (pinch) {
      if (pinchStartZoom !== undefined) return;
      const rect = viewport.getBoundingClientRect();
      zoomAt(zoom * Math.exp(-dy * 0.01), e.clientX - rect.left, e.clientY - rect.top);
    } else if (e.shiftKey && dx === 0) {
      panBy(-dy, 0);
    } else {
      panBy(-dx, -dy);
    }
  }
  // WKWebView reports trackpad pinch as native gesture events, with cumulative scale.
  function pinch(e: Event) {
    e.preventDefault();
    if (e.type === 'gesturestart') {
      pinchStartZoom = zoom;
    } else if (e.type === 'gestureend') {
      pinchStartZoom = undefined;
    } else if (pinchStartZoom !== undefined) {
      const gesture = e as MouseEvent & { scale: number };
      if (!Number.isFinite(gesture.scale) || gesture.scale <= 0) return;
      const rect = viewport.getBoundingClientRect();
      zoomAt(pinchStartZoom * gesture.scale, gesture.clientX - rect.left, gesture.clientY - rect.top);
    }
  }
  const gestureEvents = ['gesturestart', 'gesturechange', 'gestureend'];
  function onFocus(event: FocusEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target === source) select(sourceId);
    else if (target.hasAttribute('data-board-projection')) select(target.dataset.blokId ?? null);
  }
  function keyboard(e: KeyboardEvent) {
    if (e.key === 'Escape' && source.hasAttribute('data-board-editing') && !e.isComposing) {
      source.removeAttribute('data-board-editing');
      select(sourceId);
      source.focus({ preventScroll: true });
      e.preventDefault();
      return;
    }
    if (
      e.isComposing ||
      !(e.target instanceof Element) ||
      e.target.closest('textarea,input,[contenteditable=true],button,a')
    )
      return;
    if (e.key === 'Escape') {
      select(null);
      setTool('select');
    }
    if (!selectedIds.size || !editable()) return;
    const selection = singleSelection();
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void remove(selectedIds);
    }
    if (e.key === 'Enter' && selection) {
      e.preventDefault();
      edit(selection);
      if (selection === sourceId) holder.querySelector<HTMLElement>('[contenteditable=true]')?.focus();
    }
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const move = delta[e.key];
    if (move) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      void moveSelected(move[0] * step, move[1] * step);
    }
  }
  const watch = new MutationObserver(schedule);
  watch.observe(holder, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-busy', 'data-blok-readonly', 'data-board-element', 'data-board-state'],
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(source);
  resize.observe(viewport);
  paintCamera();
  for (const name of gestureEvents) viewport.addEventListener(name, pinch, { passive: false });
  viewport.addEventListener('wheel', wheel, { passive: false });
  viewport.addEventListener('keydown', keyboard);
  viewport.addEventListener('focusin', onFocus);
  setTool('select');
  sync();
  return {
    refresh: sync,
    destroy() {
      active = false;
      closeField?.();
      unbindDrop();
      unbind();
      watch.disconnect();
      resize.disconnect();
      cancelAnimationFrame(animation);
      viewport.removeEventListener('focusin', onFocus);
      for (const name of gestureEvents) viewport.removeEventListener(name, pinch);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('keydown', keyboard);
      holder.inert = wasInert;
      stage.before(holder);
      root.unmount();
      stage.remove();
    },
  };
}
