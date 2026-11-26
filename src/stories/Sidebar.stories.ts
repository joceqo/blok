<<<<<<< HEAD
/**
 * Sidebar.stories.ts — host page tree beside the editor.
 *
 * Blok stores no navigation. This story is the shell: the sidebar opens a
 * page, and the editor shows that page's document.
 */
import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, within } from 'storybook/test';
import { mountWorkspaceLibrary, type LibraryView } from '../../desktop/src/workspace-library';
import { createDesktopFooter } from '../../desktop/src/settings';
import { mountAgentAssistant } from '../shell/agent-assistant';
import { shellPreview } from './shell-story-fixtures';

import { createEditorContainer } from './helpers';
import type { EditorContainer } from './helpers';
import { createPageFrame } from '../shell/sidebar';
import type { ShellPage } from '../shell/sidebar';
import '../shell/sidebar.css';

import type { Blok as EditorApi, OutputData } from '@/types';

function documentFor(id: string, text: string): OutputData {
  return {
    time: Date.now(),
    version: '2.1.0',
    blocks: [
      {
        id: `${id}-body`,
        type: 'paragraph',
        data: { text },
      },
    ],
  };
}

const pages: ShellPage[] = [
  { id: 'home', title: 'Accueil', icon: '🏠', parentId: null },
  { id: 'notes', title: 'Notes', icon: '📝', parentId: 'home' },
  { id: 'draft', title: 'Brouillon', icon: '✏️', parentId: 'notes' },
  { id: 'ideas', title: 'Idées', icon: '💡', parentId: 'home' },
  { id: 'journal', title: 'Journal', icon: '📓', parentId: null },
];

const documents = new Map<string, OutputData>([
  ['home', documentFor('home', 'La sidebar est la navigation. Chaque ligne ouvre une page.')],
  ['notes', documentFor('notes', 'Les notes restent sous Accueil.')],
  ['draft', documentFor('draft', 'Un brouillon, encore vide de décision.')],
  ['ideas', documentFor('ideas', 'Une idée devient une page, pas un lien dans le texte.')],
  ['journal', documentFor('journal', 'Le journal est une page racine.')],
]);

function show(editor: EditorContainer, docs: Map<string, OutputData>, id: string): void {
  const data = docs.get(id) ?? { time: Date.now(), version: '2.1.0', blocks: [] };
  const paint = (): void => {
    const instance = editor.__blokEditor;
    if (instance === undefined) return;
    // The class gains render() when its prototype becomes the API. The published type is that surface.
    const api = instance as unknown as EditorApi;
    void api.render(data);
  };
  if (editor.__blokEditor) {
    paint();
    return;
  }
  const timer = window.setInterval(() => {
    if (!editor.__blokEditor) return;
    window.clearInterval(timer);
    paint();
  }, 50);
}

const render = (): HTMLElement => {
  const tree = pages.map((page) => ({ ...page }));
  const docs = new Map(documents);
  let activeId = 'home';
  const editor = createEditorContainer({
    data: docs.get(activeId),
    minHeight: 480,
    placeholder: 'Écrire…',
    autofocus: true,
  }) as EditorContainer;
  const frame = createPageFrame({
    pages: tree,
    activeId,
    onOpen(id) {
      activeId = id;
      frame.setPages(tree, activeId);
      show(editor, docs, id);
    },
    onCreate(parentId) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      tree.push({ id, title: 'Sans titre', icon: '📄', parentId });
      docs.set(id, { time: Date.now(), version: '2.1.0', blocks: [] });
      activeId = id;
      frame.setPages(tree, activeId);
      show(editor, docs, id);
    },
    onAction(action) {
      if (action.type === 'rename') {
        const page = tree.find((item) => item.id === action.id);
        if (page) page.title = action.title;
        frame.setPages(tree, activeId);
        return;
      }
      if (action.type === 'duplicate') {
        const page = tree.find((item) => item.id === action.id);
        if (!page) return;
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
        const index = tree.findIndex((item) => item.id === page.id);
        tree.splice(index + 1, 0, { ...page, id, title: `${page.title} copie` });
        const source = docs.get(page.id);
        docs.set(id, source
          ? { ...source, blocks: source.blocks.map((block) => ({ ...block, id: `${id}-body` })) }
          : { time: Date.now(), version: '2.1.0', blocks: [] });
        activeId = id;
        frame.setPages(tree, activeId);
        show(editor, docs, id);
        return;
      }
      // The rest of the page menu stays visible. This story only renames, duplicates, and trashes.
      if (action.type !== 'delete') return;
      const drop = new Set<string>();
      const pending = [action.id];
      while (pending.length > 0) {
        const current = pending.pop();
        if (!current || drop.has(current)) continue;
        drop.add(current);
        tree.filter((item) => item.parentId === current).forEach((item) => pending.push(item.id));
      }
      const parentId = tree.find((item) => item.id === action.id)?.parentId ?? null;
      for (let index = tree.length - 1; index >= 0; index -= 1) {
        if (drop.has(tree[index].id)) tree.splice(index, 1);
      }
      drop.forEach((id) => docs.delete(id));
      if (drop.has(activeId)) {
        activeId = parentId && tree.some((item) => item.id === parentId)
          ? parentId
          : tree[0]?.id ?? '';
      }
      frame.setPages(tree, activeId);
      if (activeId) show(editor, docs, activeId);
    },
  });
  editor.style.border = '0';
  editor.style.borderRadius = '0';
  editor.style.background = 'transparent';
  editor.style.boxShadow = 'none';
  frame.canvas.append(editor);
  const host = document.createElement('div');
  host.setAttribute('data-blok-theme', 'dark');
  host.append(frame.element);
  return host;
};

const meta: Meta = {
  title: 'Shell/Sidebar',
  parameters: { layout: 'fullscreen' },
  render,
};

export default meta;

type Story = StoryObj;

/** Page tree on the left, the open document on the right. */
export const PageTree: Story = {};

/** Review the desktop destinations and the workspace-scoped sidebar preferences. */
export const Navigation: Story = {
  render: (_args, {abortSignal}) => {
    const host = shellPreview('dark');
    const specimen = [
      {id: 'notes', title: 'Notes de travail', icon: '📓', parentId: null, section: 'Privé', favorite: false},
      {id: 'atelier', title: 'Atelier', icon: '🧪', parentId: null, section: 'Privé', favorite: true},
    ];
    let recentIds = ['notes', 'atelier'];
    const story = (id: string) => {
      const url = new URL('iframe.html', document.baseURI);
      url.searchParams.set('id', id); url.searchParams.set('viewMode', 'story');
      location.assign(url);
    };
    const pageHost = document.createElement('article');
    const libraryHost = document.createElement('div');
    const open = (id: string) => {
      libraryHost.hidden = true; pageHost.hidden = false;
      frame.element.querySelector('[data-blok-sidebar-library]')?.removeAttribute('aria-current');
      pageHost.replaceChildren();
      const title = document.createElement('h1'); title.textContent = specimen.find(p => p.id === id)?.title ?? '';
      pageHost.append(title); frame.setPages(specimen, id);
    };
    const create = () => {
      const id = crypto.randomUUID();
      specimen.push({id, title: 'Nouvelle page', icon: '📄', parentId: null, section: 'Privé', favorite: false});
      open(id);
    };
    const openLibrary = () => {
      assistant.close(); libraryHost.hidden = false; pageHost.hidden = true;
      frame.element.querySelector('[data-blok-sidebar-library]')?.setAttribute('aria-current', 'page');
      frame.setPages(specimen, ''); library.refresh();
    };
    const frame = createPageFrame({
      pages: specimen, activeId: '', preferenceKey: 'storybook:sidebar', recentIds, onRecentsChange: ids => { recentIds = ids; },
      onOpen: open, onCreate: create, onHome: openLibrary, onChat: () => assistant.open(), onNewChat: () => assistant.newChat(),
      onLibrary: openLibrary, onCalendar: () => story('shell-calendrier--semaine'), onSearch: () => story('shell-recherche--palette'),
    });
    const assistant = mountAgentAssistant({
      getPageText: () => pageHost.textContent ?? '', openSettings: () => story('shell-parametres--preferences'),
      listProviders: async () => [], onOpenChange: active => frame.setChatActive(active),
    });
    let view: LibraryView = 'recents';
    const library = mountWorkspaceLibrary(libraryHost, {
      workspaceName: 'Atelier local', pages: () => specimen, recentIds: () => recentIds, visitedAt: () => undefined,
      onOpen: open, onCreate: create, view: () => view,
      onViewChange: next => { view = next; library.refresh(); },
    });
    const footer = createDesktopFooter(() => {}, {kind:'local', id:'storybook:sidebar', name:'Atelier local'}, frame.headerActions, {sidebarPreferences: frame.sidebarPreferences, signal:abortSignal});
    footer.addEventListener('blok:desktop-open-library', openLibrary);
    frame.element.querySelector('[data-blok-sidebar-edge]')?.before(footer);
    assistant.editorSlot.append(pageHost, libraryHost);
    frame.canvas.append(assistant.element); host.append(frame.element); openLibrary();
    abortSignal.addEventListener('abort', () => { library.destroy(); assistant.destroy(); }, {once:true});
    return host;
  },
  play: async ({canvasElement}) => {
    const preview = within(canvasElement);
    await expect(preview.getByRole('button', {name:'Personnaliser la barre latérale'})).toBeVisible();
    await expect(preview.getByRole('button', {name:'Bibliothèque'})).toHaveAttribute('aria-current', 'page');
  },
};
||||||| f8ef3c6b39
=======
/**
 * Sidebar.stories.ts — host page tree beside the editor.
 *
 * Blok stores no navigation. This story is the shell: the sidebar opens a
 * page, and the editor shows that page's document.
 */
import type { Meta, StoryObj } from '@storybook/html-vite';

import { createEditorContainer } from './helpers';
import type { EditorContainer } from './helpers';
import { createPageFrame } from '../shell/sidebar';
import type { ShellPage } from '../shell/sidebar';
import '../shell/sidebar.css';

import type { Blok as EditorApi, OutputData } from '@/types';

function documentFor(id: string, text: string): OutputData {
  return {
    time: Date.now(),
    version: '2.1.0',
    blocks: [
      {
        id: `${id}-body`,
        type: 'paragraph',
        data: { text },
      },
    ],
  };
}

const pages: ShellPage[] = [
  { id: 'home', title: 'Accueil', icon: '🏠', parentId: null },
  { id: 'notes', title: 'Notes', icon: '📝', parentId: 'home' },
  { id: 'draft', title: 'Brouillon', icon: '✏️', parentId: 'notes' },
  { id: 'ideas', title: 'Idées', icon: '💡', parentId: 'home' },
  { id: 'journal', title: 'Journal', icon: '📓', parentId: null },
];

const documents = new Map<string, OutputData>([
  ['home', documentFor('home', 'La sidebar est la navigation. Chaque ligne ouvre une page.')],
  ['notes', documentFor('notes', 'Les notes restent sous Accueil.')],
  ['draft', documentFor('draft', 'Un brouillon, encore vide de décision.')],
  ['ideas', documentFor('ideas', 'Une idée devient une page, pas un lien dans le texte.')],
  ['journal', documentFor('journal', 'Le journal est une page racine.')],
]);

function show(editor: EditorContainer, docs: Map<string, OutputData>, id: string): void {
  const data = docs.get(id) ?? { time: Date.now(), version: '2.1.0', blocks: [] };
  const paint = (): void => {
    const instance = editor.__blokEditor;
    if (instance === undefined) return;
    // The class gains render() when its prototype becomes the API. The published type is that surface.
    const api = instance as unknown as EditorApi;
    void api.render(data);
  };
  if (editor.__blokEditor) {
    paint();
    return;
  }
  const timer = window.setInterval(() => {
    if (!editor.__blokEditor) return;
    window.clearInterval(timer);
    paint();
  }, 50);
}

const render = (): HTMLElement => {
  const tree = pages.map((page) => ({ ...page }));
  const docs = new Map(documents);
  let activeId = 'home';
  const editor = createEditorContainer({
    data: docs.get(activeId),
    minHeight: 480,
    placeholder: 'Écrire…',
    autofocus: true,
  }) as EditorContainer;
  const frame = createPageFrame({
    pages: tree,
    activeId,
    onOpen(id) {
      activeId = id;
      frame.setPages(tree, activeId);
      show(editor, docs, id);
    },
    onCreate(parentId) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      tree.push({ id, title: 'Sans titre', icon: '📄', parentId });
      docs.set(id, { time: Date.now(), version: '2.1.0', blocks: [] });
      activeId = id;
      frame.setPages(tree, activeId);
      show(editor, docs, id);
    },
    onAction(action) {
      if (action.type === 'rename') {
        const page = tree.find((item) => item.id === action.id);
        if (page) page.title = action.title;
        frame.setPages(tree, activeId);
        return;
      }
      if (action.type === 'duplicate') {
        const page = tree.find((item) => item.id === action.id);
        if (!page) return;
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
        const index = tree.findIndex((item) => item.id === page.id);
        tree.splice(index + 1, 0, { ...page, id, title: `${page.title} copie` });
        const source = docs.get(page.id);
        docs.set(id, source
          ? { ...source, blocks: source.blocks.map((block) => ({ ...block, id: `${id}-body` })) }
          : { time: Date.now(), version: '2.1.0', blocks: [] });
        activeId = id;
        frame.setPages(tree, activeId);
        show(editor, docs, id);
        return;
      }
      // The rest of the page menu stays visible. This story only renames, duplicates, and trashes.
      if (action.type !== 'delete') return;
      const drop = new Set<string>();
      const pending = [action.id];
      while (pending.length > 0) {
        const current = pending.pop();
        if (!current || drop.has(current)) continue;
        drop.add(current);
        tree.filter((item) => item.parentId === current).forEach((item) => pending.push(item.id));
      }
      const parentId = tree.find((item) => item.id === action.id)?.parentId ?? null;
      for (let index = tree.length - 1; index >= 0; index -= 1) {
        if (drop.has(tree[index].id)) tree.splice(index, 1);
      }
      drop.forEach((id) => docs.delete(id));
      if (drop.has(activeId)) {
        activeId = parentId && tree.some((item) => item.id === parentId)
          ? parentId
          : tree[0]?.id ?? '';
      }
      frame.setPages(tree, activeId);
      if (activeId) show(editor, docs, activeId);
    },
  });
  editor.style.border = '0';
  editor.style.borderRadius = '0';
  editor.style.background = 'transparent';
  editor.style.boxShadow = 'none';
  frame.canvas.append(editor);
  const host = document.createElement('div');
  host.setAttribute('data-blok-theme', 'dark');
  host.append(frame.element);
  return host;
};

const meta: Meta = {
  title: 'Shell/Sidebar',
  parameters: { layout: 'fullscreen' },
  render,
};

export default meta;

type Story = StoryObj;

/** Page tree on the left, the open document on the right. */
export const PageTree: Story = {};
>>>>>>> origin/fix/self-host-review
