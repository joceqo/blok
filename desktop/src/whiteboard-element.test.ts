import { expect, it } from 'vitest';
import { readBoardElement, renderBoardConnector, renderBoardElement, whiteboardElementTool, type BoardElement } from './whiteboard-element';

const note: BoardElement = {kind:'note', x:25,y:-10,w:160,h:100, text:'<révision> & suite', color:'#fcda66'};

it('keeps the document block blank and projects an independently readable copy', () => {
  const tool = new whiteboardElementTool({data:note});
  const wrapper = document.createElement('div');
  wrapper.dataset.blokId = 'real-block-id';
  wrapper.append(tool.render());
  tool.rendered();
  expect(wrapper.textContent).toBe('');
  expect(wrapper.style.getPropertyValue('--board-y')).toBe('-10px');
  expect(readBoardElement(wrapper)).toEqual(note);
  const projection = renderBoardElement(note);
  expect(projection.textContent).toBe(note.text);
  expect(projection.querySelector('[contenteditable]')).toBeNull();
  expect(readBoardElement(projection)).toEqual(note);
  tool.save().text = 'changed';
  expect(tool.save()).toEqual(note);
});

it('renders external links only for HTTP(S) and treats all titles as text', () => {
  const link = renderBoardElement({...note, kind:'link', url:'https://example.org/'});
  expect(link.querySelector('a')?.href).toBe('https://example.org/');
  expect(link.querySelector('a')?.rel).toContain('noopener');
  expect(link.textContent).toBe(note.text);
  expect(renderBoardElement({...note,kind:'link',url:'javascript:void(0)'}).querySelector('a')).toBeNull();
  const shape = renderBoardElement({...note,kind:'diamond',color:'url(https://example.org/color)'});
  expect(shape.style.getPropertyValue('--board-element-color')).toBe('');
});

it('draws pen strokes and attached arrows without changing their shared endpoints on layout', () => {
  const pen = renderBoardElement({...note,kind:'pen',points:[[0,1],[22,4],[36,0]]});
  expect(pen.querySelector('path')?.getAttribute('d')).toBe('M0 1 L22 4 L36 0');
  const arrow: BoardElement = {...note,kind:'arrow',from:'block-a',to:'block-b',points:[[0,0],[25,0]]};
  const wrapper = document.createElement('div');
  wrapper.append(renderBoardElement(arrow));
  renderBoardConnector(wrapper,{x:80,y:50},{x:60,y:25});
  expect(wrapper.style.getPropertyValue('--board-x')).toBe('60px');
  expect(wrapper.querySelector('path')?.getAttribute('d')).toMatch(/^M20 25 L0 0 M/);
  expect(wrapper.querySelector('svg')?.dataset.boardStart).toBe('20,25');
  expect(wrapper.querySelector('svg')?.dataset.boardEnd).toBe('0,0');
  expect(wrapper.querySelector('[pointer-events=stroke]')?.getAttribute('d')).toMatch(/^M20 25 L0 0/);
  expect(readBoardElement(wrapper)).toEqual(arrow);
});

it('retains unsupported future objects without rendering an editable block', () => {
  const data = {kind:'future-tool', custom:{value:'preserve'}};
  const tool = new whiteboardElementTool({data});
  expect(readBoardElement(tool.render())).toBeUndefined();
  expect(tool.save()).toEqual(data);
});
