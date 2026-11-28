import {shellText} from './shell-i18n';
import type { BoardElement } from './whiteboard-element';

export const frameSizes = {
  Libre: null, '1:1': [1200, 1200], '4:3': [1600, 1200], '16:9': [1600, 900], '2:1': [1600, 800],
} as const;
export type FrameFormat = keyof typeof frameSizes;
export type Template = 'mindmap' | 'kanban' | 'retro';

export function boardTemplate(template: Template, cx: number, cy: number) {
  const blocks: {id: string; type: string; data: BoardElement}[] = [];
  function place(data: BoardElement) {
    const id = crypto.randomUUID();
    blocks.push({ id, type: 'whiteboardElement', data: { ...data, x: cx + data.x, y: cy + data.y } });
    return id;
  }
  if (template === 'mindmap') {
    const root = place({ kind: 'note', x: -225, y: -44, w: 166, h: 88, text: shellText("Idée centrale"), color: '#fcd34d' });
    for (const [i, y] of [-112, 24].entries()) {
      const to = place({ kind: 'note', x: 58, y, w: 166, h: 88, text: 'Idée ' + (i + 1), color: '#badbd6' });
      place({ kind: 'arrow', x: -59, y: Math.min(0, y + 44), w: 117, h: Math.abs(y + 44), from: root, to });
    }
  } else {
    const labels = template === 'kanban' ? ['À faire', 'En cours', 'Terminé'] : ['À poursuivre', 'À améliorer', 'À essayer'];
    labels.forEach((text, i) => place({ kind: 'note', x: (i - 1) * 196 - 90, y: -60, w: 180, h: 120,
      color: ['#ffe59c', '#badbd6', '#c6c1e6'][i], text }));
  }
  return blocks;
}
