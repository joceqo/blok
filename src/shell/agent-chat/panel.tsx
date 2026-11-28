import React, { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  ArrowDown, ArrowUpRight, Check, ChevronDown, CircleHelp, Copy, Ellipsis, FileText, Lightbulb, Link2, List, Maximize2,
  MessageCircle, MessageCirclePlus, Minus, PanelRight, PictureInPicture2, RotateCcw, Settings2,
} from 'lucide';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { Menu } from '@base-ui/react/menu';
import { Icon } from './icon';
import mascot from '../../../docs/public/logo-no-sign.png';

import type { ChatAttachment } from './attachments';
import { AttachmentPreview } from './attachment-preview';

export type PanelMode = 'side' | 'floating' | 'full';
export interface ChatStep {
  label: string;
  items?: {title: string; id?: string; blockId?: string}[];
}

export interface Turn {
  steps?: ChatStep[];
  attachments?: ChatAttachment[];
  question: string;
  sources?: {id: string; title: string; blockId?: string; number: number}[];
  sent: string;
  command: string;
  label: string;
  answer: string;
  pending: boolean;
  error?: boolean;
  cancelled?: boolean;
  status?: string;
}
export interface Conversation {
  id: string;
  turns: Turn[];
  draft?: string;
  draftAttachments?: ChatAttachment[];
}

const modes = [
  {id: 'side', label: 'Barre latérale', icon: PanelRight},
  {id: 'floating', label: 'Flottant', icon: PictureInPicture2},
  {id: 'full', label: 'Plein écran', icon: Maximize2},
] as const;

const suggestions = [
  {id:'summary', text:'Résumer cette page', icon:List},
  {id:'insight', text:'Trouver les points clés', icon:Lightbulb},
  {id:'question', text:'Que manque-t-il dans cette page ?', icon:CircleHelp},
] as const;

interface PanelProps {
  titleId: string;
  open: boolean;
  mode: PanelMode;
  onMode(mode: PanelMode): void;
  conversations: Conversation[];
  active: number;
  historyOpen: boolean;
  historyLabel(chat: Conversation): string;
  onHistory(open: boolean): void;
  onSelect(index: number): void;
  onNew(): void;
  onSettings(): void;
  onCopyLink?: () => void;
  linkNotice: string;
  onClose(): void;
  composer: HTMLFormElement;
  providerHint?: string;
  canEdit: boolean;
  onEdit(): void;
  onSend(question: string, pageAction?: boolean, attachments?: ChatAttachment[]): void;
  onSource(id: string, blockId?: string): void;
}

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();

function HistoryMenu({conversations, active, historyLabel, onSelect, historyOpen, id}: Pick<PanelProps,
  'conversations' | 'active' | 'historyLabel' | 'onSelect' | 'historyOpen'> & {id: string}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {
    if (historyOpen && input.current) {
      input.current.value = '';
      setQuery('');
      input.current.focus();
    }
  }, [historyOpen]);
  const needle = normalize(query.trim());
  const matches = !historyOpen ? [] : conversations.map((chat, index) => ({chat, index, label: historyLabel(chat)})).reverse()
    .filter(({chat, label}) => [label, chat.draft ?? '', ...chat.turns.flatMap(turn => [turn.question, turn.answer])]
      .some(text => normalize(text).includes(needle)));
  return <div id={id} hidden={!historyOpen} role="dialog" aria-label="Historique des conversations" data-blok-agent-menu="history"
    onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      if (!buttons.length || event.nativeEvent.isComposing) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (at === -1 && event.key === 'Enter') { event.preventDefault(); buttons[0].click(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[event.key === 'ArrowDown' ? (at + 1) % buttons.length : (at <= 0 ? buttons.length : at) - 1].focus();
      }
    }}>
    <input ref={input} type="search" aria-label="Rechercher une conversation" placeholder="Rechercher une conversation"
      autoComplete="off" onInput={event => { const value = event.currentTarget.value; flushSync(() => setQuery(value)); }}/>
    <div data-blok-agent-history-list="">{matches.map(({chat, index, label}) =>
      <button type="button" key={chat.id} data-agent-chat-id={chat.id} aria-current={index === active || undefined}
        title={chat.turns[0]?.question || label} onClick={() => onSelect(index)}>
        <Icon icon={MessageCircle} size={15}/>
        <span>{label}</span>
      </button>)}</div>
    {!matches.length && <p role="status">Aucune conversation trouvée.</p>}
  </div>;
}

function PanelHeader(props: PanelProps) {
  const header = useRef<HTMLElement>(null);
  const historyId = props.titleId + '-history';
  const historyLabel = 'Historique : ' + props.historyLabel(props.conversations[props.active]);
  return <header ref={header} data-blok-agent-header="" onBlur={event => {
    const next = event.relatedTarget;
    if (props.historyOpen && next instanceof Element && !next.closest('[data-blok-agent-history],[data-blok-agent-menu="history"]')) props.onHistory(false);
  }}>
    <h2 className="blok-chat-sr-only" id={props.titleId}>Assistant IA</h2>
    <button type="button" data-blok-agent-history="" title={historyLabel} aria-label={historyLabel}
      aria-haspopup="dialog" aria-controls={historyId} aria-expanded={props.historyOpen}
      onClick={() => props.onHistory(!props.historyOpen)}>
      <img data-blok-agent-title-icon="" src={mascot} alt=""/>
      <span>{props.conversations[props.active].turns.length || props.conversations[props.active].draft
        ? props.historyLabel(props.conversations[props.active]) : 'Nouvelle discussion avec l’IA'}</span>
      <Icon icon={ChevronDown} size={14}/>
    </button>
    <button type="button" data-blok-agent-new="" aria-label="Nouvelle conversation" title="Commencer une nouvelle discussion"
      onClick={props.onNew}><Icon icon={MessageCirclePlus} size={18}/></button>
    {props.open && <Menu.Root modal={false}>
      <Menu.Trigger data-blok-chat-options="" aria-label="Options du chat" title="Options du chat"><Icon icon={Ellipsis} size={18}/></Menu.Trigger>
      <Menu.Portal container={header}><Menu.Positioner className="blok-chat-options-position" align="end" sideOffset={6}>
        <Menu.Popup className="blok-chat-options-menu" aria-label="Options du chat">
          {props.onCopyLink && <>
            <Menu.Item className="blok-chat-menu-item" onClick={props.onCopyLink}><Icon icon={Link2}/>Copier le lien</Menu.Item>
            <Menu.Separator className="blok-chat-menu-rule"/>
          </>}
          <Menu.Group aria-label="Affichage du chat">
            <Menu.RadioGroup value={props.mode} onValueChange={(mode: PanelMode) => props.onMode(mode)}>
              {modes.map(({id, label, icon}) => <Menu.RadioItem key={id} value={id} closeOnClick
                className="blok-chat-menu-item" data-blok-agent-mode-option={id}>
                <Icon icon={icon}/><span>{label}</span><Menu.RadioItemIndicator><Icon icon={Check} size={14}/></Menu.RadioItemIndicator>
              </Menu.RadioItem>)}
            </Menu.RadioGroup>
          </Menu.Group>
          <Menu.Separator className="blok-chat-menu-rule"/>
          <Menu.Item className="blok-chat-menu-item" onClick={props.onSettings}>
            <Icon icon={Settings2}/>Réglages
          </Menu.Item>
        </Menu.Popup>
      </Menu.Positioner></Menu.Portal>
    </Menu.Root>}
    <button type="button" aria-label="Réduire le chat" title="Réduire le chat" onClick={props.onClose}><Icon icon={Minus}/></button>
    {props.linkNotice && <span className="blok-chat-link-notice" role="status">{props.linkNotice}</span>}
    <HistoryMenu {...props} id={historyId}/>
  </header>;
}

function Suggestions({onSend}: Pick<PanelProps, 'onSend'>) {
  return <div data-blok-chat-suggestions="" role="group" aria-label="Suggestions pour l’assistant">
    {suggestions.map(({id, text, icon}) => <button key={id} type="button" data-blok-chat-suggestion={id}
      onClick={() => onSend(text, true)}><Icon icon={icon}/><span>{text}</span><Icon icon={ArrowUpRight} size={14}/></button>)}
  </div>;
}

function TurnActivity({turn, onSource}: Pick<PanelProps,'onSource'> & {turn: Turn}) {
  if (!turn.steps) return null;
  const summary = turn.pending ? turn.status : turn.cancelled ? 'Réponse arrêtée' : turn.error ? 'Activité interrompue' : 'Activité';
  return <details data-blok-chat-activity="" data-running={turn.pending ? '' : undefined}
    data-blok-agent-running={turn.pending ? '' : undefined}>
    <summary><span data-blok-chat-activity-text="" className={turn.pending ? 'shimmer' : undefined}
      aria-live="polite" aria-atomic="true">{summary}</span><Icon icon={ChevronDown} size={13}/></summary>
    <ol>{turn.steps.map((step, i) => <li key={i}>{step.label}
      {!!step.items?.length && <ul>{step.items.map((item, j) => <li key={j}>
        {item.id ? <button type="button" onClick={() => onSource(item.id!, item.blockId)}>{item.title}</button> : item.title}
      </li>)}</ul>}
    </li>)}</ol>
  </details>;
}

function ChatTurn({turn, onSend, onSource}: Pick<PanelProps, 'onSend' | 'onSource'> & {turn: Turn}) {
  return <div data-blok-agent-turn="">
    <article data-blok-chat-message="user" aria-label="Votre message"><div data-blok-chat-message-body="">{turn.question}</div>{!!turn.attachments?.length && <div data-blok-chat-images="">{turn.attachments.map((item,i) => <AttachmentPreview key={i} item={item}/>)}</div>}</article>
    <TurnActivity turn={turn} onSource={onSource}/>
    {!turn.pending && !turn.cancelled && <article data-blok-chat-message={turn.error ? 'error' : 'assistant'} role={turn.error ? 'alert' : undefined}
          aria-label={turn.error ? 'Erreur de l’assistant' : 'Réponse de l’assistant'}>
          {!turn.error && turn.label && <div data-blok-chat-message-meta="">{turn.label}</div>}
          <div data-blok-chat-message-body="">{turn.answer}</div>
          {!!turn.sources?.length && !turn.error && <div data-blok-answer-sources="">{turn.sources.map(source =>
            <button key={source.number} type="button" onClick={() => onSource(source.id, source.blockId)}>
              <Icon icon={FileText} size={13}/>[{source.number}] {source.title || 'Page sans titre'}
            </button>)}</div>}
          <div data-blok-chat-message-actions="">{turn.error
            ? <button type="button" onClick={() => onSend(turn.question, false, turn.attachments)}><Icon icon={RotateCcw}/>Réessayer</button>
            : <button type="button" onClick={() => { void navigator.clipboard?.writeText(turn.answer).catch(() => undefined); }}>
                <Icon icon={Copy} size={14}/>Copier</button>}</div>
        </article>}
  </div>;
}

function AssistantPanel(props: PanelProps) {
  const composerSlot = useRef<HTMLDivElement>(null);
  const chat = props.conversations[props.active];
  const last = chat.turns.at(-1);
  const fullWelcome = props.mode === 'full' && !last;
  // Keep Blok's shared composer, including the native host's input preferences and model menu.
  useLayoutEffect(() => {
    composerSlot.current!.append(props.composer);
    return () => props.composer.remove();
  }, [props.composer]);
  return <>
    <PanelHeader {...props}/>
    {last ? <MessageScroller.Provider key={chat.id} defaultScrollPosition="end" autoScroll>
      <MessageScroller.Root className="blok-chat-scroll">
        <MessageScroller.Viewport aria-label="Conversation" data-blok-agent-transcript="">
          <MessageScroller.Content>{chat.turns.map((turn, i) =>
            <MessageScroller.Item key={i} messageId={chat.id + '-' + i}>
              <ChatTurn turn={turn} onSend={props.onSend} onSource={props.onSource}/>
            </MessageScroller.Item>)}</MessageScroller.Content>
        </MessageScroller.Viewport>
        <MessageScroller.Button className="blok-chat-latest" direction="end" aria-label="Dernier message"
          title="Dernier message"><Icon icon={ArrowDown}/></MessageScroller.Button>
      </MessageScroller.Root>
    </MessageScroller.Provider> : <div data-blok-agent-transcript=""><div data-blok-agent-empty="">
            <span data-blok-agent-empty-mark="" aria-hidden="true"><img src={mascot} alt=""/></span>
            <p>Comment puis-je t’aider ?</p>
            {!fullWelcome && <Suggestions onSend={props.onSend}/>}
          </div></div>}
    <div data-blok-agent-composer="">
      <div ref={composerSlot} className="blok-chat-input-slot"/>
      {props.providerHint && <p data-blok-agent-providers-empty="">{props.providerHint}</p>}
      <div className="blok-chat-context-actions">
        <button type="button" data-blok-agent-edit-page="" hidden={!props.canEdit} onClick={props.onEdit}>Modifier la page avec OpenAI</button>
      </div>
    </div>
    <div data-blok-agent-suggestions="" hidden={!fullWelcome}>{fullWelcome && <Suggestions onSend={props.onSend}/>}</div>
  </>;
}

export function mountPanelView(host: HTMLElement) {
  const root = createRoot(host);
  return {
    update(props: PanelProps) { flushSync(() => root.render(<AssistantPanel {...props}/>)); },
    destroy() { root.unmount(); },
  };
}
