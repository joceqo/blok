import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { createPageToolbar } from '../../desktop/src/page-toolbar';
import { mountPageWhiteboard } from '../../desktop/src/page-whiteboard';
import { whiteboardElementTool, type BoardElement } from '../../desktop/src/whiteboard-element';
import { Blok } from '../blok';
import { BoldInlineTool } from '../components/inline-tools/inline-tool-bold';
import { Paragraph } from '../tools/paragraph';
import { shellPreview } from './shell-story-fixtures';

import type { Blok as EditorAPI, OutputData } from '@/types';

const page: OutputData = {
  title: 'Revue design',
  blocks: [
    { id: 'brief', type: 'paragraph', data: { text: 'Préparer la revue du <b>jeud</b>.' } },
    { id: 'notes', type: 'paragraph', data: { text: 'Réunir les retours de l’équipe.' } },
  ],
};

function element(id: string, data: BoardElement) {
  return { id, type: 'whiteboardElement', data };
}

const palette: OutputData = {
  title: 'Première invitation',
  blocks: [
    { id: 'objective', type: 'paragraph', data: { text: '<b>Objectif</b> · Inviter un collègue dès la création du premier espace.' } },
    { id: 'metric', type: 'paragraph', data: { text: 'Mesurer le délai entre l’invitation et la première contribution à deux.' } },
    element('origin', { kind: 'document', x: 48, y: 48, w: 400, h: 190 }),
    element('insight', { kind: 'note', x: 136, y: 339, w: 245, h: 133, color: '#ffe59c', text: 'Retour d’entretien\n« Mon collègue a-t-il reçu le lien ? »' }),
    element('decision', { kind: 'note', x: 582, y: 342, w: 242, h: 120, color: '#badbd6', text: 'À tester\nAfficher le statut de l’invitation dans l’espace.' }),
    element('flow', { kind: 'frame', x: 473, y: 48, w: 511, h: 252, text: 'Parcours proposé', color: '#9b9aaf' }),
    element('invite', { kind: 'rectangle', x: 496, y: 123, w: 142, h: 66, text: 'Envoyer le lien', color: '#89b9e8' }),
    element('join', { kind: 'diamond', x: 686, y: 102, w: 134, h: 108, text: 'Accepté ?', color: '#d7ad6c' }),
    element('start', { kind: 'ellipse', x: 851, y: 123, w: 111, h: 66, text: 'Rejoindre', color: '#a2c59e' }),
    element('sent', { kind: 'arrow', x: 638, y: 156, w: 48, h: 1, from: 'invite', to: 'join', color: '#a5acbc' }),
    element('accepted', { kind: 'arrow', x: 820, y: 156, w: 31, h: 1, from: 'join', to: 'start', color: '#a5acbc' }),
  ],
};

function whiteboardPage(signal: AbortSignal, initial = page, initialView: 'document' | 'whiteboard' = 'document'): HTMLElement {
  const theme = initialView === 'whiteboard' ? 'dark' : 'light';
  const shell = shellPreview(theme);
  const controls = document.createElement('div');
  const toolbar = createPageToolbar([{ id: 'page', title: initial.title ?? '' }], false, () => {}, undefined, undefined,
    { workspaceName: 'Atelier', viewControls: controls });
  const article = document.createElement('article');
  const holder = document.createElement('div');
  const reopen = document.createElement('button');

  article.setAttribute('data-desktop-document', '');
  article.style.overflow = 'auto';
  reopen.type = 'button';
  reopen.textContent = 'Rouvrir la page';
  toolbar.element.querySelector('[data-desktop-page-actions]')!.append(reopen);
  article.append(holder);
  shell.append(toolbar.element, article);
  signal.addEventListener('abort', () => toolbar.destroy(), { once: true });

  // Keep only serialized output between sessions. Each story starts with an ordinary page.
  let snapshot = JSON.stringify(initial);
  let readyEditor: EditorAPI | null = null;
  let editor: Blok;
  let board: ReturnType<typeof mountPageWhiteboard>;
  const open = (): void => {
    reopen.disabled = true;
    board = mountPageWhiteboard({ holder, controls, initialView, getEditor: () => readyEditor });
    editor = new Blok({
      holder,
      pageTitle: { placeholder: 'Nouvelle page' },
      theme,
      minHeight: 0,
      tools: {
        paragraph: { class: Paragraph, inlineToolbar: true },
        bold: BoldInlineTool,
        whiteboardElement: whiteboardElementTool,
      },
      persistence: {
        load: async () => JSON.parse(snapshot) as OutputData,
        save: async (data) => { snapshot = JSON.stringify(data); },
      },
    });
    const instance = editor;
    void instance.isReady.then(() => {
      if (signal.aborted || instance !== editor) return;
      readyEditor = instance as unknown as EditorAPI;
      board.refresh();
      reopen.disabled = false;
    });
  };
  const close = (): void => {
    board.destroy();
    readyEditor = null;
    editor.destroy();
  };
  reopen.addEventListener('click', () => {
    close();
    open();
  }, { signal });
  signal.addEventListener('abort', close, { once: true });
  open();
  return shell;
}

const meta: Meta = {
  title: 'Shell/Desktop/Tableau blanc',
  parameters: { layout: 'fullscreen' },
  render: (_args, { abortSignal }) => whiteboardPage(abortSignal),
};
export default meta;
type Story = StoryObj;

export const Document: Story = {};

export const Palette: Story = {
  render: (_args, { abortSignal }) => whiteboardPage(abortSignal, palette, 'whiteboard'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('[data-board-projection][data-blok-id="accepted"]')).toBeVisible());
    const viewport = canvas.getByRole('region', { name: 'Surface du tableau blanc' });
    const world = viewport.querySelector<HTMLElement>('.blok-board-world')!;
    await waitFor(() => {
      expect(canvas.getByRole('button', { name: 'Crayon' })).toBeEnabled();
      const note = viewport.querySelector('[data-board-source-id]')!.getBoundingClientRect();
      expect(note.left).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().left + 31);
      expect(canvasElement.querySelector('[data-blok-id="start"][data-board-projection]')!.getBoundingClientRect().right)
        .toBeLessThanOrEqual(viewport.getBoundingClientRect().right - 31);
    });
    const automaticCamera = world.style.transform;
    await userEvent.click(canvas.getByRole('button', { name: 'Ajuster au contenu' }));
    expect(world.style.transform).toBe(automaticCamera);
  },
};

export const EditionEtReouverture: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const source = (): HTMLElement => {
      const node = canvasElement.querySelector<HTMLElement>('[data-blok-id="brief"] [contenteditable="true"]');
      if (!node) throw new Error('Le paragraphe source est absent.');
      return node;
    };
    const pageNote = (): HTMLElement => {
      const note = canvasElement.querySelector<HTMLElement>('[data-board-source-id="page-note"]');
      if (!note) throw new Error('La note du document est absente.');
      return note;
    };
    const sticky = () => canvasElement.querySelector<HTMLElement>('[data-board-projection][data-kind="note"]');
    let createdNoteId: string | null = null;
    const bold = (): Element | null => source().querySelector('b, strong');

    await step('Retrouver les paragraphes du document sur le tableau', async () => {
      await waitFor(() => expect(source()).toBeVisible());
      await userEvent.click(canvas.getByRole('button', { name: 'Tableau blanc' }));
      await waitFor(() => expect(pageNote()).toContainElement(source()));
      expect(pageNote()).toHaveTextContent('Réunir les retours de l’équipe.');
      await waitFor(() => expect(canvas.getByRole('button', { name: 'Note' })).toBeVisible());
    });

    await step('Corriger le mot en gras dans la note', async () => {
      await userEvent.dblClick(pageNote());
      await waitFor(() => expect(pageNote()).toHaveAttribute('data-board-editing'));
      const word = bold()?.firstChild;
      if (!word) throw new Error('Le mot en gras est absent.');
      source().focus();
      window.getSelection()?.collapse(word, 4);
      await userEvent.keyboard('i');
      expect(bold()).toHaveTextContent('jeudi');
    });

    await step('Créer une note sur le tableau depuis le dock', async () => {
      expect(sticky()).toBeNull();
      await userEvent.click(canvas.getByRole('button', { name: 'Note' }));
      const viewport = canvas.getByRole('region', { name: 'Surface du tableau blanc' });
      const box = viewport.getBoundingClientRect();
      const clientX = Math.min(box.right - 32, pageNote().getBoundingClientRect().right + 24);
      const clientY = box.top + 24;
      const target = viewport.ownerDocument.elementFromPoint(clientX, clientY);
      if (!target || !viewport.contains(target)) throw new Error('La surface du tableau doit être accessible.');
      await userEvent.pointer({ keys: '[MouseLeft]', target, coords: { clientX, clientY } });
      const field = await canvas.findByRole('textbox', { name: 'Texte de l’élément' });
      const editorBounds = field.parentElement!.getBoundingClientRect();
      const paper = getComputedStyle(field.parentElement!).backgroundColor;
      expect(getComputedStyle(field).backgroundColor).toBe('rgba(0, 0, 0, 0)');
      await userEvent.clear(field);
      await userEvent.type(field, 'Prêt pour jeudi');
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      await waitFor(() => expect(sticky()).toHaveTextContent('Prêt pour jeudi'));
      const savedNote = sticky()!.querySelector<HTMLElement>('[data-board-element]')!;
      expect(getComputedStyle(savedNote).backgroundColor).toBe(paper);
      expect(savedNote.getBoundingClientRect().toJSON()).toEqual(editorBounds.toJSON());
      createdNoteId = sticky()?.getAttribute('data-blok-id') ?? null;
      expect(createdNoteId).toBeTruthy();
      await userEvent.click(canvas.getByRole('button', { name: 'Document' }));
      await waitFor(() => expect(canvasElement.querySelector('[data-whiteboard-dock]')).toBeNull());
      expect(source()).toBeVisible();
      expect(bold()).toHaveTextContent('jeudi');
    });

    await step('Rouvrir le document enregistré et retrouver la note', async () => {
      const previous = source();
      await userEvent.click(canvas.getByRole('button', { name: 'Rouvrir la page' }));
      await waitFor(() => {
        expect(previous).not.toBeInTheDocument();
        expect(bold()).toHaveTextContent('jeudi');
      });
      await userEvent.click(canvas.getByRole('button', { name: 'Tableau blanc' }));
      await waitFor(() => expect(pageNote()).toContainElement(source()));
      expect(bold()).toHaveTextContent('jeudi');
      expect(pageNote()).toHaveTextContent('Réunir les retours de l’équipe.');
      await waitFor(() => expect(sticky()).toHaveTextContent('Prêt pour jeudi'));
      expect(sticky()).toHaveAttribute('data-blok-id', createdNoteId);
    });
  },
};

export const DessinLibre: Story = {
  render: (_args, { abortSignal }) => whiteboardPage(abortSignal, page, 'whiteboard'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByRole('region', { name: 'Surface du tableau blanc' });
    await userEvent.click(await canvas.findByRole('button', { name: 'Crayon' }));
    const rect = viewport.getBoundingClientRect();
    const coords = { clientX: rect.left + 32, clientY: rect.top + 32 };
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: viewport, coords },
      { target: viewport, coords: { clientX: coords.clientX + 28, clientY: coords.clientY + 16 } },
      { keys: '[/MouseLeft]', target: viewport },
    ]);
    const stroke = await canvas.findByRole('group', { name: 'Trait' });
    expect(stroke).not.toHaveAttribute('data-board-selected');
    expect(getComputedStyle(stroke).outlineStyle).toBe('none');
  },
};

export const DeplacementEtZoom: Story = {
  render: (_args, { abortSignal }) => whiteboardPage(abortSignal, page, 'whiteboard'),
  play: async ({ canvasElement }) => {
    const viewport = within(canvasElement).getByRole('region', { name: 'Surface du tableau blanc' });
    const note = await within(viewport).findByRole('group', { name: 'Note du document' });
    const original = note.getBoundingClientRect();
    const { left, top } = viewport.getBoundingClientRect();
    const pointer = { clientX: left + 150, clientY: top + 100 };
    function wheel(options: WheelEventInit) {
      viewport.dispatchEvent(new WheelEvent('wheel', { cancelable: true, bubbles: true, ...pointer, ...options }));
    }
    // A small board can be panned past its origin even when it fits in the viewport.
    wheel({ deltaX: -220, deltaY: -140 });
    const panned = note.getBoundingClientRect();
    expect(panned.left - original.left).toBeCloseTo(220);
    expect(panned.top - original.top).toBeCloseTo(140);
    wheel({ ctrlKey: true, deltaY: 10 });
    const zoomed = note.getBoundingClientRect();
    const ratio = zoomed.width / panned.width;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1);
    expect(zoomed.left - pointer.clientX).toBeCloseTo((panned.left - pointer.clientX) * ratio, 2);
    expect(zoomed.top - pointer.clientY).toBeCloseTo((panned.top - pointer.clientY) * ratio, 2);
    wheel({ deltaX: 520 });
    expect(note.getBoundingClientRect().left).toBeCloseTo(zoomed.left - 520, 2);
  },
};

export const SelectionParRectangle: Story = {
  render: (_args, { abortSignal }) => whiteboardPage(abortSignal, palette, 'whiteboard'),
  play: async ({ canvasElement }) => {
    const viewport = within(canvasElement).getByRole('region', { name: 'Surface du tableau blanc' });
    const left = await within(viewport).findByText(/Retour d’entretien/);
    const right = await within(viewport).findByText(/Afficher le statut/);
    const first = left.closest<HTMLElement>('[data-board-projection]')!;
    const second = right.closest<HTMLElement>('[data-board-projection]')!;
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    const camera = viewport.querySelector<HTMLElement>('.blok-board-world')!;
    const transform = camera.style.transform;
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: viewport, coords: { clientX: a.left - 4, clientY: a.bottom + 4 } },
      { target: viewport, coords: { clientX: b.right, clientY: b.top + 2 } },
    ]);
    expect(first).toHaveAttribute('data-board-selected');
    expect(second).toHaveAttribute('data-board-selected');
    await userEvent.pointer([
      { target: viewport, coords: { clientX: a.right, clientY: a.top + 2 } },
      { keys: '[/MouseLeft]', target: viewport },
    ]);
    expect(first).toHaveAttribute('data-board-selected');
    expect(second).not.toHaveAttribute('data-board-selected');
    expect(camera.style.transform).toBe(transform);
  },
};

export const DepotImages: Story = {
  render: (_args, { abortSignal }) => whiteboardPage(abortSignal, page, 'whiteboard'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByRole('region', { name: 'Surface du tableau blanc' });
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Crayon' })).toBeEnabled());
    const bitmap = document.createElement('canvas');
    bitmap.width = 80;
    bitmap.height = 40;
    bitmap.getContext('2d')!.fillRect(0, 0, 80, 40);
    const blob = await new Promise<Blob>(resolve => bitmap.toBlob(result => resolve(result!)));
    const transfer = new DataTransfer();
    for (const name of ['Capture.png', 'Photo.png']) {
      transfer.items.add(new File([blob], name, { type: 'image/png' }));
    }

    const rect = viewport.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + 50);
    for (const type of ['dragover', 'drop']) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX, clientY });
      viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    const image = (name: string) => canvasElement.querySelector<HTMLImageElement>('[data-board-projection] img[alt="' + name + '"]');
    await waitFor(() => {
      expect(image('Capture.png')?.naturalWidth).toBe(80);
      expect(image('Photo.png')?.naturalHeight).toBe(40);
    });
    const bounds = image('Capture.png')!.getBoundingClientRect();
    expect(Math.abs(bounds.left - clientX)).toBeLessThan(1);
    expect(Math.abs(bounds.top - clientY)).toBeLessThan(1);
    const first = image('Capture.png')!;
    for (const [dx, dy] of [[45, 35], [-30, 18]]) {
      const before = first.getBoundingClientRect();
      const start = { clientX: Math.round(before.left + 4), clientY: Math.round(before.top + 4) };
      const end = { clientX: start.clientX + dx, clientY: start.clientY + dy };
      await userEvent.pointer([
        { keys: '[MouseLeft>]', target: first, coords: start },
        { target: viewport, coords: end },
      ]);
      const followsPointer = () => {
        const current = first.getBoundingClientRect();
        expect(Math.abs(current.left - before.left - dx)).toBeLessThan(1);
        expect(Math.abs(current.top - before.top - dy)).toBeLessThan(1);
      };
      followsPointer();
      await userEvent.pointer({ keys: '[/MouseLeft]', target: viewport, coords: end });
      await waitFor(followsPointer);
    }
    await userEvent.click(canvas.getByRole('button', { name: 'Rouvrir la page' }));
    await waitFor(() => {
      expect(first).not.toBeInTheDocument();
      expect(image('Capture.png')?.naturalWidth).toBe(80);
      expect(image('Photo.png')?.naturalHeight).toBe(40);
    });
  },
};
