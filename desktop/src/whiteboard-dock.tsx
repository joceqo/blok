import {shellText} from './shell-i18n';
import { ArrowUpRight, Circle, Diamond, Frame, Hand, Link2, Maximize, Minus, MousePointer2, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { frameSizes, type FrameFormat, type Template } from './whiteboard-options';
import './whiteboard-dock.css';

export type BoardTool = 'select' | 'hand' | 'note' | 'text' | 'rectangle' | 'ellipse' | 'diamond' | 'frame' | 'pen' | 'arrow' | 'link' | 'eraser';

interface BoardDockProps {
  tool: BoardTool;
  onTool: (tool: BoardTool) => void;
  zoom: number;
  onZoom: (change: 'in' | 'out' | 'fit') => void;
  readOnly: boolean;
  onFormat: (format: FrameFormat) => void;
  onTemplate: (template: Template) => void;
  color?: string;
  onColor: (color: string) => void;
  strokeWidth: number;
  onStrokeWidth: (width: number) => void;
}

const labels: Record<BoardTool, string> = {
  select: 'Sélection', hand: 'Main', note: 'Note', text: shellText("Texte"), rectangle: 'Rectangle',
  ellipse: 'Ellipse', diamond: 'Losange', frame: 'Cadre', pen: 'Crayon', arrow: 'Flèche',
  link: 'Lien', eraser: 'Gomme',
};

const quickIcons = { select: MousePointer2, hand: Hand, frame: Frame, arrow: ArrowUpRight, link: Link2, ellipse: Circle, diamond: Diamond };

function ToolIcon({ tool }: { tool: BoardTool }) {
  if (tool in quickIcons) {
    const Icon = quickIcons[tool as keyof typeof quickIcons];
    return <Icon size={20} strokeWidth={1.7} aria-hidden="true" />;
  }
  return <span aria-hidden="true" className={'board-dock-art board-dock-art-' + tool}>
    {tool === 'text' && <><i>H₁</i><i>T</i></>}
    {tool === 'rectangle' && <><i /><i /></>}
    {tool === 'note' && <i />}
  </span>;
}

/** Tab enters the toolbar at its current tool; arrow keys also traverse the shape picker. */
function arrowFocus(event: KeyboardEvent<HTMLElement>) {
  const key = event.key;
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const index = buttons.findIndex(button => button === event.target);
  if (index < 0 || !buttons.length) return;
  event.preventDefault();
  event.stopPropagation();
  if (key === 'Home') buttons[0]?.focus();
  else if (key === 'End') buttons.at(-1)?.focus();
  else {
    const direction = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    buttons[(index + buttons.length + direction) % buttons.length]?.focus();
  }
}

const colors = [
  ['Rose', '#fa7085'], ['Orange', '#ff903e'], ['Jaune', '#fcd34d'], ['Vert', '#77cd82'],
  ['Bleu', '#85caff'], ['Violet', '#b397ed'], ['Gris', '#979797'], ['Blanc', '#ffffff'], ['Noir', '#222222'],
] as const;
const shapes: BoardTool[] = ['rectangle', 'ellipse', 'diamond'];
type Panel = 'frame' | 'shapes' | 'pen' | 'arrow' | 'note' | 'templates';
function panelFor(tool: BoardTool): Panel | null {
  if (shapes.includes(tool)) return 'shapes';
  if (tool === 'frame' || tool === 'pen' || tool === 'arrow' || tool === 'note') return tool;
  return null;
}

export function BoardDock({ tool, onTool, zoom, onZoom, readOnly, onFormat, onTemplate, color, onColor,
  strokeWidth, onStrokeWidth }: BoardDockProps) {
  const [open, setOpen] = useState<Panel | null>(null);
  const tray = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = !readOnly && (open === 'templates' || open === panelFor(tool)) ? open : null;
  useEffect(() => {
    if (!panel) return;
    const doc = tray.current?.ownerDocument;
    function outside(e: PointerEvent) {
      if (e.target instanceof Node && !tray.current?.contains(e.target)) setOpen(null);
    }
    doc?.addEventListener('pointerdown', outside, true);
    return () => doc?.removeEventListener('pointerdown', outside, true);
  }, [panel]);

  function button(value: BoardTool, art: BoardTool = value) {
    const next = panelFor(value);
    return <button type="button" data-board-tool={value} aria-label={labels[value]} title={labels[value]}
      aria-pressed={tool === value} aria-expanded={next ? panel === next : undefined}
      onClick={e => {
        trigger.current = e.currentTarget;
        onTool(value);
        setOpen(next === panel ? null : next);
      }}>
      <ToolIcon tool={art} />
    </button>;
  }
  function template(value: Template) { setOpen(null); onTemplate(value); }
  return <div data-whiteboard-dock="" onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="board-dock-zoom" role="group" aria-label={shellText("Zoom du tableau")}>
      <button type="button" data-board-zoom="fit" aria-label={shellText("Ajuster au contenu")} title={shellText("Ajuster au contenu")}
        onClick={() => onZoom('fit')}><Maximize size={17} aria-hidden="true" /></button>
      <button type="button" data-board-zoom="out" aria-label={shellText("Zoom arrière")} title={shellText("Zoom arrière")}
        onClick={() => onZoom('out')}><Minus size={16} aria-hidden="true" /></button>
      <output aria-label={shellText("Niveau de zoom")}>{Math.round(zoom * 100)} %</output>
      <button type="button" data-board-zoom="in" aria-label={shellText("Zoom avant")} title={shellText("Zoom avant")}
        onClick={() => onZoom('in')}><Plus size={16} aria-hidden="true" /></button>
    </div>
    <div ref={tray} className="board-dock-tray" role="toolbar" aria-label={shellText("Outils du tableau")} onKeyDown={e => {
      if (e.key === 'Escape' && panel) {
        e.stopPropagation();
        setOpen(null);
        trigger.current?.focus();
      } else arrowFocus(e);
    }}>
      <div className="board-dock-quick">
        {button('select')}{button('hand')}
        {!readOnly && <>{button('frame')}{button('arrow')}{button('link')}</>}
      </div>
      {!readOnly && <div className="board-dock-studio">
        {button('text')}{button('pen')}{button('eraser')}
        {button(shapes.includes(tool) ? tool : 'rectangle', 'rectangle')}{button('note')}
        <button type="button" aria-label={shellText("Insérer une carte mentale")} title={shellText("Insérer une carte mentale")}
          onClick={() => template('mindmap')}><span aria-hidden="true" className="board-dock-art board-dock-map" /></button>
        <button type="button" aria-expanded={panel === 'templates'} aria-label={shellText("Modèles")} title={shellText("Modèles")}
          onClick={e => { trigger.current = e.currentTarget; setOpen(panel === 'templates' ? null : 'templates'); }}>
          <span aria-hidden="true" className="board-dock-art board-dock-templates" />
        </button>
      </div>}
      {panel && <div role="group" aria-label={shellText("Options de l’outil")} className="board-dock-options" data-options={panel}>
        {panel === 'frame' && (Object.keys(frameSizes) as FrameFormat[]).map(format =>
          <button type="button" key={format} aria-pressed={format === 'Libre'}
            onClick={() => { setOpen(null); onFormat(format); }}>{format}</button>)}
        {panel === 'templates' && <>
          <button type="button" onClick={() => template('kanban')}>{shellText("Tableau de tâches")}</button>
          <button type="button" onClick={() => template('retro')}>{shellText("Rétrospective")}</button>
        </>}
        {panel === 'shapes' && shapes.map(value =>
          <button key={value} type="button" aria-pressed={tool === value} aria-label={labels[value]} title={labels[value]}
            onClick={() => onTool(value)}>{value === 'rectangle' ? '▢' : <ToolIcon tool={value} />}</button>)}
        {(panel === 'pen' || panel === 'arrow') && (panel === 'pen' ? [1, 3, 6, 10] : [1, 2.5, 5, 8]).map(width =>
          <button key={width} type="button" aria-pressed={strokeWidth === width} aria-label={width + ' px'} title={width + ' px'}
            onClick={() => onStrokeWidth(width)}><i className="board-dock-weight" style={{ width: width + 3, height: width + 3 }} /></button>)}
        {panel !== 'frame' && panel !== 'templates' && colors.map(([label, hex]) =>
          <button key={hex} type="button" className="board-dock-color" aria-label={label} title={label}
            aria-pressed={color === hex || (!color && hex === '#fcd34d' && panel === 'shapes')}
            onClick={() => onColor(hex)}><i style={{ backgroundColor: hex }} /></button>)}
      </div>}
    </div>
  </div>;
}
