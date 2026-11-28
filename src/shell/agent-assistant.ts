import { isEscapeConsumed } from '../components/utils/consumed-escape';
/**
 * Host chrome for the assistant: a button that opens a panel. The in-editor
 * Ask AI bar is Blok's. This panel calls the host model (a CLI by default) and does not run
 * blok_* tools itself.
 */

import type { AgentModel, AgentModelMessage, AgentModelResponse } from '../../types/api';
import { attachmentContext, attachmentImages, type ChatAttachment } from './agent-chat/attachments';
import { createChatComposer } from './agent-chat/composer';
import { mountPanelView, type Conversation, type ChatStep, type PanelMode, type Turn } from './agent-chat/panel';
import './agent-chat/styles.css';
import { createCliAgentModel, inspectCli, providerLabel, type CliCommand, type CliStatus } from './agent-model';
import { readAgentSettings, subscribeAgentSettings } from './agent-settings';
import './agent-assistant.css';

export interface AgentAssistantProvider { id: string; label: string }

interface LinkedChat {
  id: string;
  turns: Pick<Turn, 'question' | 'answer' | 'label' | 'sources'>[];
}

export interface AgentAssistantOptions {
  acceptAttachments?: boolean;
  chatLinks?: {
    copy(chat: LinkedChat): Promise<void>;
    save(chat: LinkedChat): void;
    read(id: string): LinkedChat | undefined;
  };
  onOpenChange?(open: boolean): void;
  workspaceSearch?: {
    find(query: string, signal: AbortSignal): Promise<{id: string; title: string; excerpt: string; blockId?: string}[]>;
    /** `blockId` names the block the match came from, when the search could cite one. */
    open(id: string, blockId?: string): void;
  };
  editPage?: { available(): boolean; open(): void };
  /** Visible text of the currently open page, read when the question is sent. */
  getPageText: () => string;
  getPageTitle?: () => string;
  /** Closes the panel, then the host opens provider settings. */
  openSettings: () => void;
  /** Host-specific provider inspection, e.g. Tauri's native CLI bridge. */
  inspectProvider?: (command: CliCommand, signal: AbortSignal) => Promise<CliStatus>;
  /** Host-specific model, leaving the Node CLI adapter as the default. */
  modelFor?(providerId: string, onProgress: (status: string) => void): AgentModel;
  /** Preferred connected provider when this panel opens. */
  preferredProvider?: () => string | null;
  /** Host discovery replaces the default CLI list. IDs are opaque to this panel. */
  listProviders?: (signal: AbortSignal) => Promise<AgentAssistantProvider[]>;
  /** Persist the user's provider/model choice in the host. */
  onProviderSelected?: (providerId: string) => void;
}

export interface AgentAssistantHandle {
  refreshPageActions(): void;
  searchableChats(): {id: string; title: string; excerpt: string}[];
  openChat(id: string): void;
  newChat(): void;
  element: HTMLElement;
  editorSlot: HTMLElement;
  open: () => void;
  close: () => void;
  destroy: () => void;
  refreshProviders: () => Promise<void>;
}

const MODE_KEY = 'blok.shell.agent.panel-mode';
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const START_WIDTH = 392;

const SYSTEM = [
  'You are the writing assistant beside a Blok page.',
  'Reply in the user\'s language, in plain text.',
  'Do not claim you edited the page.',
].join('\n');

const readMode = (): PanelMode => {
  try {
    const value = localStorage.getItem(MODE_KEY);

    if (value === 'floating' || value === 'full' || value === 'side') return value;
  } catch {
    // Private mode starts on the side panel.
  }

  return 'side';
};

const writeMode = (mode: PanelMode): void => {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // The choice still applies to this page.
  }
};

const clampWidth = (value: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));

const historyLabel = (conversation: Conversation): string => {
  const first = conversation.turns.find((turn) => turn.question.trim() !== '');

  const text = first?.question || conversation.draft || '';
  if (!text.trim()) return 'Nouvelle conversation';

  const trimmed = text.trim().replace(/\s+/g, ' ');

  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
};

const answerOf = (response: AgentModelResponse): string => response.content
  .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
  .filter((text) => text.trim() !== '')
  .join('\n')
  .trim();

const NO_PASSAGE = 'Je n’ai trouvé aucun passage pertinent dans les pages de cet espace auxquelles vous avez accès.';
const INSUFFICIENT = 'Les passages consultés ne donnent pas assez d’informations pour répondre à cette question.';
const SEARCH_INSTRUCTIONS = [
  'Answer only from the current page and numbered excerpts in the supplied data.',
  'For each claim from an excerpt, cite its number in square brackets, like [2].',
  'A shared topic alone is insufficient. If the evidence does not answer the question, return only INSUFFICIENT_EVIDENCE.',
].join(' ');

const runningLabel = (label: string): string => `${label} répond…`;
const isCliCommand = (id: string): id is CliCommand => id === 'codex' || id === 'claude';

const makeButton = (label: string): HTMLButtonElement => {
  const node = document.createElement('button');

  node.type = 'button';
  node.textContent = label;

  return node;
};

/**
 * The assistant button and its panel. Modes are remembered. Provider buttons
 * use host discovery when provided, otherwise enabled, connected CLIs.
 */
export const mountAgentAssistant = (options: AgentAssistantOptions): AgentAssistantHandle => {
  const titleId = `blok-agent-title-${crypto.randomUUID()}`;
  const panelId = `blok-agent-panel-${crypto.randomUUID()}`;
  const shell = document.createElement('div');
  const bar = document.createElement('div');
  const toggle = makeButton('Assistant IA');
  const body = document.createElement('div');
  const editorSlot = document.createElement('div');
  const panel = document.createElement('div');
  const viewHost = document.createElement('div');
  viewHost.className = 'blok-chat-view';
  const view = mountPanelView(viewHost);
  let returnFocus: HTMLElement | null = null;
  let providerHint = '';
  let linkNotice = '';
  let noticeTimer: ReturnType<typeof setTimeout>;
  const linked = new Set<string>();
  const snapshot = (chat: Conversation): LinkedChat => ({
    id: chat.id,
    turns: chat.turns.filter(t => !t.pending && !t.cancelled && !t.error).map(({question, answer, label, sources}) => ({question, answer, label, sources})),
  });
  const resize = document.createElement('div');
  const session = {
    open: false,
    mode: readMode(),
    width: START_WIDTH,
    historyOpen: false,
    conversations: [{ id: crypto.randomUUID(), turns: [] }] as Conversation[],
    active: 0,
    picked: null as string | null,
    providers: [] as AgentAssistantProvider[],
    destroyed: false,
    statuses: [] as CliStatus[],
    run: null as AbortController | null,
    token: { id: 0 },
    inspect: null as AbortController | null,
  };
  const composerHandle = createChatComposer({
    acceptAttachments: options.acceptAttachments,
    providers: [],
    sendLabel: 'Envoyer à l\'assistant IA',
    onSend: (message, provider, attachments) => {
      if (!session.providers.some((item) => item.id === provider)) return;
      session.picked = provider;
      send(message, false, attachments);
    },
    onStop: () => { stopRun(); render(); },
    onProviderChange: (provider) => {
      if (!session.providers.some((item) => item.id === provider)) return;
      session.picked = provider; options.onProviderSelected?.(provider);
    },
  });
  composerHandle.field.addEventListener('input', () => {
    const conversation = current();
    if (conversation) conversation.draft = composerHandle.field.value;
  });
  shell.setAttribute('data-blok-agent-shell', '');
  bar.setAttribute('data-blok-agent-bar', '');
  toggle.setAttribute('data-blok-agent-toggle', '');
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);
  body.setAttribute('data-blok-agent-body', '');
  editorSlot.setAttribute('data-blok-agent-editor', '');
  editorSlot.tabIndex = 0;
  editorSlot.setAttribute('role', 'region');
  editorSlot.setAttribute('aria-label', 'Page');
  panel.id = panelId;
  panel.setAttribute('data-blok-agent-panel', '');
  // Non-modal: the page editor stays reachable beside the panel, Escape closes
  // only the panel, and typing in the page is the point of "Cette page".
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', titleId);
  panel.setAttribute('hidden', '');
  composerHandle.submit.setAttribute('data-blok-agent-send', '');
  resize.setAttribute('data-blok-agent-resize', '');
  resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-orientation', 'vertical');
  resize.setAttribute('aria-label', 'Largeur du panneau');
  resize.setAttribute('aria-valuemin', String(MIN_WIDTH));
  resize.setAttribute('aria-valuemax', String(MAX_WIDTH));
  resize.tabIndex = 0;
  panel.append(resize, viewHost);
  body.append(editorSlot, panel);
  bar.append(toggle);
  shell.append(bar, body);

  const current = (): Conversation | undefined => session.conversations[session.active];

  const stopRun = (): void => {
    session.token = { id: session.token.id + 1 };
    session.run?.abort();
    session.run = null;

    const conversation = current();
    const last = conversation?.turns[conversation.turns.length - 1];

    if (last !== undefined && last.pending) {
      last.pending = false;
      last.cancelled = true;
    }
  };

  const paintProviders = (usable: AgentAssistantProvider[]): void => {
    session.providers = usable;
    composerHandle.setProviders(usable, session.picked ?? undefined);
    render();
  };

  const refreshProviders = async (): Promise<void> => {
    if (session.destroyed) return;
    const gate = new AbortController();
    session.inspect?.abort(); session.inspect = gate;
    try {
      let usable: AgentAssistantProvider[];
      if (options.listProviders) {
        const listed = await options.listProviders(gate.signal);
        const ids = new Set<string>();
        usable = listed.filter((item) => {
          if (!item.id || ids.has(item.id)) return false;
          ids.add(item.id); return true;
        }).map((item) => ({id:item.id,label:item.label.trim() || item.id}));
      } else {
        const inspect = options.inspectProvider ?? ((command: CliCommand, signal: AbortSignal) => inspectCli(command, signal, true));
        const statuses = await Promise.all([inspect('codex',gate.signal),inspect('claude',gate.signal)]);
        if (gate.signal.aborted || session.inspect !== gate) return;
        session.statuses = statuses;
        const settings = readAgentSettings();
        usable = settings.order.filter((command) => {
          const status = statuses.find((item) => item.command === command);
          return status !== undefined && status.installed && status.connected && settings.enabled[command];
        }).map((command) => ({id:command,label:providerLabel(command)}));
      }
      if (gate.signal.aborted || session.inspect !== gate || session.destroyed) return;
      const preferred = options.preferredProvider?.();
      if (!usable.some((item) => item.id === session.picked)) session.picked = null;
      if (session.picked === null) session.picked = preferred && usable.some((item) => item.id === preferred) ? preferred : usable[0]?.id ?? null;
      providerHint = 'Configurez un modèle dans les paramètres.';
      paintProviders(usable);
    } catch (error) {
      if (gate.signal.aborted || session.inspect !== gate || session.destroyed) return;
      session.picked = null;
      providerHint = error instanceof Error ? error.message : 'Impossible de charger les modèles disponibles.';
      paintProviders([]);
    }
  };

  const historyButton = () => panel.querySelector<HTMLButtonElement>('[data-blok-agent-history]');

  const paintPanel = (): void => {
    if (session.destroyed) return;
    view.update({
      titleId, open: session.open, mode: session.mode, conversations: session.conversations, active: session.active,
      historyOpen: session.historyOpen, historyLabel, composer: composerHandle.element,
      providerHint: session.providers.length ? undefined : providerHint,
      canEdit: !!options.editPage?.available() && session.providers.some(provider => provider.id.startsWith('openai:')),
      onMode(mode) {
        session.mode = mode;
        session.historyOpen = false;
        writeMode(mode);
        render();
      },
      onHistory(open) { session.historyOpen = open; paintPanel(); },
      onSelect(index) {
        selectChat(index);
        render();
        if (composerHandle.field.disabled) historyButton()?.focus();
        else composerHandle.focus();
      },
      linkNotice,
      onCopyLink: options.chatLinks ? async () => {
        const chat = current()!;
        try {
          await options.chatLinks!.copy(snapshot(chat));
          linked.add(chat.id);
          linkNotice = 'Lien copié';
        } catch { linkNotice = 'Impossible de copier le lien.'; }
        if (session.destroyed) return;
        clearTimeout(noticeTimer);
        paintPanel();
        noticeTimer = setTimeout(() => { linkNotice = ''; paintPanel(); }, 2300);
      } : undefined,
      onNew: newChat,
      onClose: close,
      onSettings() { close(); options.openSettings(); },
      onEdit() {
        if (options.editPage?.available()) { close(); options.editPage.open(); }
      },
      onSend: send,
      onSource(id, blockId) {
        if (blockId === undefined) options.workspaceSearch?.open(id);
        else options.workspaceSearch?.open(id, blockId);
      },
    });
  };

  const render = (): void => {
    const openLabel = session.open ? 'Fermer l\'assistant IA' : 'Ouvrir l\'assistant IA';

    toggle.textContent = 'Assistant IA';
    toggle.setAttribute('aria-label', openLabel);
    toggle.setAttribute('aria-expanded', session.open ? 'true' : 'false');

    if (session.open) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');

    panel.setAttribute('data-blok-agent-mode', session.mode);
    panel.toggleAttribute('data-blok-agent-empty-view', current()?.turns.length === 0);
    panel.setAttribute('role', session.mode === 'full' ? 'region' : 'dialog');
    panel.style.setProperty('--blok-agent-width', `${session.width}px`);
    resize.setAttribute('aria-valuenow', String(session.width));

    if (session.open && session.mode === 'side') resize.removeAttribute('hidden');
    else resize.setAttribute('hidden', '');

    composerHandle.setRunning(session.run !== null);
    paintPanel();
  };

  const send = (question: string, pageAction = false, attachments?: ChatAttachment[]): void => {
    const text = question.trim();
    const command = session.picked;
    const conversation = current();

    if (text === '' || session.run !== null || command === null || conversation === undefined) return;

    // Explicit current-page actions need only the page. Other substantive questions can
    // consult readable workspace passages as well. A greeting requires neither context.
    const greeting = /^(bonjour|bonsoir|salut|coucou|merci|hello|hi|thanks)[!.?\s]*$/i.test(text);
    const targetsPage = /\b(cette page|ce document|la page (courante|actuelle|ouverte)|this (page|document)|current page)\b/i.test(text);
    const mentionsWorkspace = /\b(espace|workspace|autres? pages?|other pages?)\b/i.test(text);
    const page = (greeting || (attachments?.length && !targetsPage)) ? '' : options.getPageText().trim();
    const search = attachments?.length || greeting || pageAction || (targetsPage && !mentionsWorkspace) ? undefined : options.workspaceSearch;
    const sent = page ? `${text}\n\nPage:\n${page}` : text;
    const label = session.providers.find((item) => item.id === command)?.label ?? (isCliCommand(command) ? providerLabel(command) : command);
    const steps: ChatStep[] = [];
    if (page) steps.push({label:'Page ouverte incluse', items:[{title:options.getPageTitle?.().trim() || 'Page actuelle'}]});
    if (attachments?.length) steps.push({label:'Pièces jointes préparées', items:attachments.map(file => ({
      title:file.kind === 'video' ? file.name + ' · ' + file.frames.length + (file.frames.length === 1 ? ' vue' : ' vues') + ' · sans son' : file.name,
    }))});
    if (search) steps.push({label:'Recherche dans l’espace'});
    const turn: Turn = { question: text, steps, attachments, sent, command, label, answer: '', pending: true, status: search ? 'Recherche dans l’espace…' : runningLabel(label) };
    const prior: AgentModelMessage[] = conversation.turns.flatMap((item) => (
      search || item.sources !== undefined || item.pending || item.answer === ''
        ? []
        : [
          { role: 'user' as const, content: item.sent },
          { role: 'assistant' as const, content: item.answer },
        ]
    ));
    const controller = new AbortController();
    const token = { id: session.token.id + 1 };

    conversation.draft = '';
    conversation.turns.push(turn);
    session.run = controller;
    session.token = token;
    session.historyOpen = false;
    composerHandle.setText('');
    render();

    void Promise.resolve().then(async () => {
      let context = sent + attachmentContext(attachments ?? []);
      if ((pageAction || (targetsPage && !mentionsWorkspace)) && !page && !attachments?.length) {
        steps.push({label:'Aucun texte sur la page ouverte'});
        turn.label = '';
        return 'Ouvre une page contenant du texte pour que je puisse répondre à son sujet.';
      }
      if (search) {
        controller.signal.throwIfAborted();
        const sources = await search.find(text, controller.signal);
        controller.signal.throwIfAborted();
        turn.sources = sources.map(({id, title, blockId}, index) => ({id, title, blockId, number: index + 1}));
        steps.push({
          label:sources.length ? (sources.length === 1 ? '1 passage trouvé' : sources.length + ' passages trouvés') : 'Aucun passage trouvé',
          items:sources.map(({id, title, blockId}) => ({id, title:title || 'Page sans titre', blockId})),
        });
        if (!sources.length && !page) {
          turn.label = '';
          return NO_PASSAGE;
        }
        turn.status = runningLabel(label);
        paintPanel();
        context = JSON.stringify({ question: text, currentPage: page.slice(0, 5000),
          sources: sources.map(({title, excerpt}, index) => ({number:index + 1, title, excerpt})) });
      }
      const model = options.modelFor?.(command, (status) => {
        if (session.token !== token || !turn.pending || turn.status === status) return;
        steps.push({label:status});
        turn.status = status; paintPanel();
      }) ?? (isCliCommand(command) ? createCliAgentModel({command}) : null);
      if (!model) throw new Error('Ce modèle nécessite un adaptateur fourni par l’application.');
      controller.signal.throwIfAborted();
      steps.push({label:'Demande au modèle · ' + label});
      paintPanel();
      const response = await model({
        system: search ? SYSTEM + ' ' + SEARCH_INSTRUCTIONS : SYSTEM,
        ...(attachments?.length ? {images: attachmentImages(attachments)} : {}),
        messages: [...prior, {role:'user',content:context}], tools:[], signal:controller.signal,
      });
      const answer = answerOf(response);
      if (!turn.sources) return answer;
      const references = [...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)]
        .flatMap(match => match[1].split(',').map(Number));
      const candidates = turn.sources;
      const insufficient = answer === 'INSUFFICIENT_EVIDENCE' || (!page && !references.length)
        || references.some(number => number < 1 || number > candidates.length);
      turn.sources = insufficient ? [] : candidates.filter(source => references.includes(source.number));
      return insufficient ? INSUFFICIENT : answer;
    }).then((answer) => {
      if (session.token !== token) return;

      turn.answer = answer;
      turn.pending = false;
      turn.error = false;
      if (linked.has(conversation.id)) {
        try { options.chatLinks?.save(snapshot(conversation)); } catch { linkNotice = 'Impossible de mettre à jour le lien.'; }
      }
      session.run = null;
      render();
    }, (error: unknown) => {
      if (session.token !== token) return;

      turn.pending = false;
      if (!controller.signal.aborted) {
        turn.answer = error instanceof Error ? error.message : String(error);
        turn.error = true;
      }
      session.run = null;
      render();
    });
  };

  function selectChat(index: number): void {
    if (session.active !== index) {
      const previous = current();
      if (previous) { previous.draft = composerHandle.field.value; previous.draftAttachments = composerHandle.getAttachments(); }
      stopRun();
      composerHandle.setAttachments(session.conversations[index].draftAttachments ?? []);
      composerHandle.setText(session.conversations[index].draft ?? '');
    }
    session.active = index;
    session.historyOpen = false;
  }

  const open = (): void => {
    if (!session.open && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) returnFocus = document.activeElement;
    session.open = true;
    options.onOpenChange?.(true);
    session.picked = null;
    render();
    void refreshProviders();
    composerHandle.focus();
  };

  const close = (): void => {
    const restore = panel.contains(document.activeElement);
    session.open = false;
    options.onOpenChange?.(false);
    session.historyOpen = false;
    render();
    if (restore) {
      const opener = returnFocus?.isConnected ? returnFocus : getComputedStyle(bar).display === 'none' ? editorSlot : toggle;
      if (opener.hidden) queueMicrotask(() => { if (!session.open) opener.focus({preventScroll:true}); });
      else opener.focus({preventScroll:true});
    }
    returnFocus = null;
  };

  toggle.addEventListener('click', () => {
    if (session.open) close();
    else open();
  });
  const newChat = (): void => {
    const conversation = current();

    if (conversation && (conversation.turns.length > 0 || composerHandle.field.value.trim() || composerHandle.getAttachments().length)) {
      const blank = session.conversations.findIndex((chat,index) => index !== session.active && !chat.turns.length && !chat.draft && !chat.draftAttachments?.length);
      if (blank === -1) session.conversations.push({ id: crypto.randomUUID(), turns: [] });
      selectChat(blank === -1 ? session.conversations.length - 1 : blank);
    }

    session.historyOpen = false;
    render();
    composerHandle.focus();
  };
  let releaseResize: (() => void) | undefined;
  const onPointerDown = (event: PointerEvent): void => {
    if (session.mode !== 'side' || !session.open) return;

    releaseResize?.();
    const startX = event.clientX;
    const startWidth = session.width;
    const move = (ev: PointerEvent): void => {
      session.width = clampWidth(startWidth + startX - ev.clientX);
      panel.style.setProperty('--blok-agent-width', `${session.width}px`);
      resize.setAttribute('aria-valuenow', String(session.width));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      releaseResize = undefined;
    };

    releaseResize = up;
    event.preventDefault();
    resize.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  resize.addEventListener('pointerdown', onPointerDown);
  resize.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? 16 : -16;

    session.width = clampWidth(session.width + delta);
    panel.style.setProperty('--blok-agent-width', `${session.width}px`);
    resize.setAttribute('aria-valuenow', String(session.width));
  });

  const onPointerAway = (event: Event): void => {
    if (!session.historyOpen || !(event.target instanceof Element)) return;
    if (panel.contains(event.target) && event.target.closest('[data-blok-agent-menu="history"],[data-blok-agent-history]')) return;
    session.historyOpen = false;
    paintPanel();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (panel.querySelector('[data-blok-chat-options][aria-expanded="true"]')) return;
    if (event.defaultPrevented || isEscapeConsumed(event) || event.key !== 'Escape' || !session.open) return;

    event.preventDefault();
    event.stopPropagation();

    if (session.historyOpen) {
      session.historyOpen = false;
      render();
      historyButton()?.focus();

      return;
    }

    close();
  };

  document.addEventListener('pointerdown', onPointerAway);
  document.addEventListener('keydown', onKey);

  const onSettingsChanged = (): void => { void refreshProviders(); };
  const unsubscribe = subscribeAgentSettings(onSettingsChanged);
  window.addEventListener('blok:ai-settings-changed', onSettingsChanged);

  render();
  void refreshProviders();

  return {
    newChat() { open(); newChat(); },
    searchableChats: () => session.conversations.filter(item => item.turns.length > 0).map(item => ({
      id: item.id,
      title: historyLabel(item),
      excerpt: item.turns.map(turn => [turn.question, turn.answer].filter(Boolean).join('\n')).join('\n\n'),
    })).reverse(),
    openChat(id) {
      let index = session.conversations.findIndex(item => item.id === id);
      if (index === -1) {
        const saved = options.chatLinks?.read(id);
        if (!saved) return;
        linked.add(id);
        index = session.conversations.push({id, turns: saved.turns.map(turn => ({
          ...turn, command: '', sent: turn.question, pending: false,
        }))}) - 1;
      }
      selectChat(index);
      open();
    },
    element: shell,
    editorSlot,
    open,
    close,
    refreshProviders,
    refreshPageActions: paintPanel,
    destroy: () => {
      session.destroyed = true;
      stopRun();
      session.inspect?.abort();
      releaseResize?.();
      clearTimeout(noticeTimer);
      composerHandle.destroy();
      view.destroy();
      unsubscribe();
      window.removeEventListener('blok:ai-settings-changed', onSettingsChanged);
      document.removeEventListener('pointerdown', onPointerAway);
      document.removeEventListener('keydown', onKey);
      shell.remove();
    },
  };
};
