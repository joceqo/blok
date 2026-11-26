import type { BlockTool } from '../../types';
import './whiteboard-element.css';

const labels = {
  document: 'Document', note: 'Note', text: 'Texte', rectangle: 'Rectangle', ellipse: 'Ellipse',
  diamond: 'Losange', frame: 'Cadre', pen: 'Trait', arrow: 'Flèche', link: 'Lien', image: 'Image',
};

export type BoardElement = {
  kind: keyof typeof labels;
  x: number; y: number; w: number; h: number;
  text?: string;
  points?: number[][];
  url?: string;
  from?: string; to?: string;
  color?: string;
  strokeWidth?: number;
};

type Point = {x: number; y: number};
const svgNamespace = 'http://www.w3.org/2000/svg';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function isBoardElement(value: unknown): value is BoardElement {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BoardElement>;
  return typeof item.kind === 'string' && Object.hasOwn(labels, item.kind) &&
    finite(item.x) && finite(item.y) && finite(item.w) && item.w >= 0 && finite(item.h) && item.h >= 0 &&
    [item.text, item.color, item.url, item.from, item.to].every(field => field === undefined || typeof field === 'string') &&
    (item.points === undefined || (Array.isArray(item.points) && item.points.every(point =>
      Array.isArray(point) && point.length >= 2 && finite(point[0]) && finite(point[1]))));
}

function elementRoot(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.hasAttribute('data-board-element') ? wrapper : wrapper.querySelector<HTMLElement>('[data-board-element]');
}

export function readBoardElement(wrapper: HTMLElement): BoardElement | undefined {
  const serialized = elementRoot(wrapper)?.dataset.boardState;
  if (!serialized) return;
  try {
    const data: unknown = JSON.parse(serialized);
    if (isBoardElement(data)) return data;
  } catch { /* An incomplete projection has no usable geometry. */ }
}

function setBounds(element: HTMLElement, {x,y,w,h}: Pick<BoardElement, 'x'|'y'|'w'|'h'>): void {
  element.style.setProperty('--board-x', x + 'px');
  element.style.setProperty('--board-y', y + 'px');
  element.style.setProperty('--board-w', Math.max(1,w) + 'px');
  element.style.setProperty('--board-h', Math.max(1,h) + 'px');
}

function modelRoot(item: BoardElement): HTMLElement {
  const root = document.createElement('div');
  root.dataset.boardElement = item.kind;
  root.dataset.boardState = JSON.stringify(item);
  setBounds(root, item);
  return root;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string,string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function pathData(points: number[][], arrow: boolean): string {
  if (!points.length) return '';
  // A two-vertex zero-length line with round caps also paints a single pen tap.
  const vertices = points.length === 1 ? [points[0], points[0]] : points;
  let data = vertices.map(([x,y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ');
  if (!arrow) return data;
  const [x,y] = vertices[vertices.length - 1];
  let index = vertices.length - 2;
  while (index >= 0 && vertices[index][0] === x && vertices[index][1] === y) index--;
  const previous = vertices[index];
  if (previous) {
    const dx = x - previous[0], dy = y - previous[1];
    const length = Math.hypot(dx,dy);
    const size = Math.min(12,length * 0.65);
    const baseX = x - size * dx/length, baseY = y - size * dy/length;
    const sideX = -dy/length * size * 0.48, sideY = dx/length * size * 0.48;
    data += ` M${baseX + sideX} ${baseY + sideY} L${x} ${y} L${baseX - sideX} ${baseY - sideY}`;
  }
  return data;
}

function appendHitStroke(drawing: SVGSVGElement, visible: SVGGraphicsElement): void {
  const hit = visible.cloneNode(false) as SVGGraphicsElement;
  hit.setAttribute('stroke', 'transparent');
  hit.setAttribute('stroke-width', '12');
  hit.removeAttribute('stroke-dasharray');
  hit.setAttribute('pointer-events', 'stroke');
  drawing.append(visible,hit);
}

function setStroke(drawing: SVGSVGElement, points: number[][], arrow: boolean): void {
  const path = pathData(points, arrow);
  for (const stroke of drawing.querySelectorAll('path')) stroke.setAttribute('d', path);
  if (arrow && points.length) {
    drawing.dataset.boardStart = points[0].join(',');
    drawing.dataset.boardEnd = points[points.length - 1].join(',');
    for (const handle of drawing.querySelectorAll<SVGCircleElement>('[data-board-endpoint]')) {
      const point = handle.dataset.boardEndpoint === 'start' ? points[0] : points[points.length - 1];
      handle.setAttribute('cx', String(point[0]));
      handle.setAttribute('cy', String(point[1]));
    }
  }
}

function drawStroke(root: HTMLElement, item: BoardElement): void {
  const w = Math.max(1,item.w), h = Math.max(1,item.h);
  const drawing = svg('svg', {viewBox:`0 0 ${w} ${h}`, preserveAspectRatio:'none', 'aria-hidden':'true'});
  const arrow = item.kind === 'arrow';
  const points = item.points ?? (arrow ? [[0,0], [w,h]] : []);
  const path = svg('path', {fill:'none', stroke:'currentColor',
    'stroke-width':String(finite(item.strokeWidth) ? Math.max(1, Math.min(16, item.strokeWidth)) : arrow ? 2.5 : 3), 'stroke-linecap':'round', 'stroke-linejoin':'round'});
  appendHitStroke(drawing,path);
  if (arrow) {
    for (const end of ['start', 'end']) drawing.append(svg('circle', {'data-board-endpoint': end}));
  }
  setStroke(drawing,points,arrow);
  root.append(drawing);
}

/** Derive an attached arrow's display from current endpoints without changing its stored block. */
export function renderBoardConnector(wrapper: HTMLElement, start: Point, end: Point): void {
  const root = elementRoot(wrapper);
  if (root?.dataset.boardElement !== 'arrow') return;
  const drawing = root.querySelector('svg');
  if (!drawing) return;
  const x = Math.min(start.x,end.x), y = Math.min(start.y,end.y);
  const w = Math.max(1,Math.abs(end.x-start.x)), h = Math.max(1,Math.abs(end.y-start.y));
  setBounds(wrapper, {x,y,w,h});
  drawing.setAttribute('viewBox', `0 0 ${w} ${h}`);
  setStroke(drawing, [[start.x-x,start.y-y],[end.x-x,end.y-y]], true);
}

function webAddress(raw?: string): URL | undefined {
  if (!raw) return;
  try {
    const url = new URL(raw);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url;
  } catch { /* An incomplete address can be edited as text. */ }
}

export function renderBoardElement(item: BoardElement, resolveAsset?: (url: string) => Promise<string>): HTMLElement {
  const root = modelRoot(item);
  root.className = 'blok-board-element';
  root.setAttribute('role', item.kind === 'link' ? 'group' : 'img');
  root.setAttribute('aria-label', [labels[item.kind], item.text].filter(Boolean).join(' · '));
  // SVG paint also accepts external resources. Only pass ordinary color values to it.
  if (item.color && /^(?:#[a-f\d]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%/+\-]+\))$/i.test(item.color)) {
    root.style.setProperty('--board-element-color', item.color);
    if (/^#[a-f\d]{6}$/i.test(item.color)) {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(item.color!.slice(i, i + 2), 16) / 255)
        .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      root.style.setProperty('--board-label-color', 0.2126*r + 0.7152*g + 0.0722*b < 0.18 ? '#fff' : '#211f1b');
    }
  } else if (item.kind === 'rectangle' || item.kind === 'ellipse' || item.kind === 'diamond') {
    root.dataset.boardDefaultShape = '';
  }
  if (item.kind === 'pen' || item.kind === 'arrow') {
    drawStroke(root, item);
  } else if (item.kind === 'image') {
    const image = document.createElement('img');
    image.alt = item.text || 'Image';
    image.draggable = false;
    root.append(image);
    const url = item.url ?? '';
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(url)) image.src = url;
    else if (/^\/files\/[a-z0-9_-]+(?:\.[a-z0-9]+)?$/i.test(url)) {
      if (resolveAsset) void resolveAsset(url).then(src => { image.src = src; }).catch(() => {
        image.alt += ' (image indisponible)';
      });
      else image.src = url;
    }
  } else if (item.kind === 'link') {
    const url = webAddress(item.url);
    const label = item.text || url?.hostname || item.url || labels.link;
    if (url) {
      const link = document.createElement('a');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = label;
      root.append(link);
    } else root.textContent = label;
  } else if (item.kind !== 'document') {
    if (item.kind === 'frame') {
      const w = Math.max(1,item.w), h = Math.max(1,item.h);
      const drawing = svg('svg', {viewBox:`0 0 ${w} ${h}`, preserveAspectRatio:'none', 'aria-hidden':'true'});
      const outline = svg('rect', {x:'0',y:'0',width:String(w),height:String(h),rx:'6',fill:'none',
        stroke:'currentColor', 'stroke-width':'1.5','stroke-dasharray':'5 4','vector-effect':'non-scaling-stroke'});
      appendHitStroke(drawing,outline);
      root.append(drawing);
    } else if (item.kind === 'diamond') {
      const drawing = svg('svg', {viewBox:'0 0 100 100', preserveAspectRatio:'none', 'aria-hidden':'true'});
      drawing.append(svg('polygon', {points:'50,1 99,50 50,99 1,50', 'vector-effect':'non-scaling-stroke'}));
      root.append(drawing);
    }
    if (item.text) {
      const caption = document.createElement('span');
      caption.textContent = item.text;
      root.append(caption);
    }
  }
  return root;
}

/** One ordinary page block owns the object. The board projects its display outside the document text. */
class WhiteboardElementTool implements BlockTool {
  static readonly isReadOnlySupported = true;
  static readonly acceptsChildren = false;
  static readonly sanitize = {text:'plaintext', url:'plaintext'} as const;
  private readonly data: Record<string,unknown>;
  private root?: HTMLElement;

  constructor({data}: {data: Record<string,unknown>}) {
    this.data = structuredClone(data);
  }

  render(): HTMLElement {
    // Future object kinds survive a load/save with a client that cannot draw them.
    const root = isBoardElement(this.data) ? modelRoot(this.data) : document.createElement('div');
    root.setAttribute('aria-hidden', 'true');
    this.root = root;
    return root;
  }

  rendered(): void {
    const block = this.root?.closest<HTMLElement>('[data-blok-id]');
    if (block && isBoardElement(this.data)) setBounds(block,this.data);
  }

  save(): Record<string,unknown> {
    return structuredClone(this.data);
  }
}

export { WhiteboardElementTool as whiteboardElementTool };
