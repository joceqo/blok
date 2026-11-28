import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ArrowUp, ChevronDown, Plus, Square } from 'lucide';
import { Icon } from './icon';
import { PopoverDesktop } from '../../components/utils/popover';
import { PopoverEvent } from '../../../types/utils/popover/popover-event';
import { IconCheck } from '../../components/icons';

import { fileAccept, readAttachments, type ChatAttachment } from './attachments';
import { AttachmentPreview } from './attachment-preview';

export interface ChatProvider {
  id: string;
  label: string;
}

export interface ChatComposerOptions {
  providers: readonly ChatProvider[];
  selectedProvider?: string;
  sendLabel?: string;
  acceptAttachments?: boolean;
  onSend: (message: string, provider: string, attachments?: ChatAttachment[]) => void;
  onStop?: () => void;
  onProviderChange?: (provider: string) => void;
}

export interface ChatComposerHandle {
  element: HTMLFormElement;
  field: HTMLTextAreaElement;
  submit: HTMLButtonElement;
  setRunning: (running: boolean) => void;
  setProviders: (providers: readonly ChatProvider[], selectedProvider?: string) => void;
  setText: (text: string) => void;
  getAttachments: () => ChatAttachment[];
  setAttachments: (attachments: ChatAttachment[]) => void;
  focus: () => void;
  destroy: () => void;
}

export const createChatComposer = (options: ChatComposerOptions): ChatComposerHandle => {
  const element = document.createElement('form');
  element.setAttribute('data-blok-chat-composer', '');
  element.setAttribute('aria-label', 'Message à l’assistant');
  const root = createRoot(element);
  const input = createRef<HTMLTextAreaElement>();
  const picker = createRef<HTMLInputElement>();
  const trigger = createRef<HTMLButtonElement>();
  const submit = createRef<HTMLButtonElement>();
  const labelId = 'blok-chat-model-' + crypto.randomUUID();
  let providers = options.providers;
  let selected = options.selectedProvider ?? '';
  let running = false;
  let hasText = false;
  let destroyed = false;
  let menu: PopoverDesktop | null = null;

  let attachments: ChatAttachment[] = [];
  let error = '';
  let reading = false;
  let revision = 0;
  const setAttachments = (next: ChatAttachment[]) => {
    revision++;
    attachments = next;
    error = '';
    reading = false;
    render();
  };
  const add = async (files: File[]) => {
    if (!options.acceptAttachments || running || reading || !files.length) return;
    const version = revision;
    reading = true;
    error = '';
    render();
    try {
      const batch = await readAttachments(files, attachments);
      if (version === revision) attachments = [...attachments, ...batch];
    } catch (cause) {
      if (version === revision) error = cause instanceof Error ? cause.message : 'Image illisible.';
    } finally {
      if (!destroyed && version === revision) { reading = false; render(); }
    }
  };
  const isFileDrag = (e: DragEvent) => options.acceptAttachments && Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const dragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    element.toggleAttribute('data-image-over', !running && !reading);
  };
  element.addEventListener('dragover', dragOver);
  element.addEventListener('dragleave', e => {
    if (!(e.relatedTarget instanceof Node) || !element.contains(e.relatedTarget)) element.removeAttribute('data-image-over');
  });
  element.addEventListener('drop', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    element.removeAttribute('data-image-over');
    void add(Array.from(e.dataTransfer!.files));
  });
  element.addEventListener('paste', e => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (options.acceptAttachments && files.length) { e.preventDefault(); void add(files); }
  });

  const syncInput = () => {
    const field = input.current!;
    field.style.height = 'auto';
    field.style.height = Math.max(52, Math.min(field.scrollHeight, 144)) + 'px';
    field.style.overflowY = field.scrollHeight > 144 ? 'auto' : 'hidden';
    const next = Boolean(field.value.trim());
    if (hasText !== next) { hasText = next; render(); }
  };
  const setText = (text: string) => { input.current!.value = text; syncInput(); };
  const openModels = (last = false) => {
    if (destroyed || !providers.length) return;
    if (menu?.isShown) { menu.hide(); return; }
    const searchable = providers.length > 8;
    const button = trigger.current!;
    const popover = new PopoverDesktop({
      trigger: button, class:'blok-chat-provider-menu', searchable,
      messages:{search:'Rechercher un modèle…'}, width:'auto', minWidth:'240px', autoFocusFirstItem:searchable,
      items:providers.map(item => ({name:item.id, title:item.label, toggle:labelId,
        isActive:() => selected === item.id, trailingIcon:selected === item.id ? IconCheck : undefined,
        closeOnActivate:true, onActivate:() => { selected = item.id; options.onProviderChange?.(item.id); render(); },
      })),
    });
    menu = popover;
    const surface = popover.getElement();
    surface.id = labelId + '-menu';
    surface.setAttribute('data-blok-chat-model-menu', '');
    surface.setAttribute('aria-label', 'Modèles IA');
    const style = getComputedStyle(button);
    for (let i = 0; i < style.length; i++) {
      const token = style.item(i);
      if (token.startsWith('--blok-')) surface.style.setProperty(token, style.getPropertyValue(token));
    }
    popover.on(PopoverEvent.Closed, () => {
      if (menu !== popover) return;
      menu = null;
      if (!destroyed) {
        render();
        if (button.isConnected) button.focus();
      }
      queueMicrotask(() => popover.destroy());
    });
    render();
    popover.show();
    if (!searchable) popover.focusItemByName(last ? providers[providers.length - 1].id : selected);
  };
  function render() {
    const label = providers.find(item => item.id === selected)?.label ?? 'Choisir un modèle';
    flushSync(() => root.render(<>
      {attachments.length > 0 && <div data-blok-chat-images="">{attachments.map((item, i) =>
        <AttachmentPreview key={i} item={item} disabled={reading} remove={() => setAttachments(attachments.filter((_, index) => index !== i))}/>)}</div>}
      {reading && <small role="status">Préparation des pièces jointes…</small>}
      {error && <small role="alert">{error}</small>}
      <textarea ref={input} aria-label="Demander à l’assistant" placeholder="Demander à l’assistant…" rows={2}
        disabled={running} onInput={syncInput} onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          if (element.ownerDocument.documentElement.hasAttribute('data-blok-chat-enter-newline') && !event.metaKey && !event.ctrlKey) return;
          event.preventDefault();
          if (!submit.current?.disabled) element.requestSubmit();
        }}/>
      <div data-blok-chat-composer-controls="">
        {options.acceptAttachments && <><input hidden ref={picker} type="file" accept={fileAccept} multiple onChange={e => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void add(files);
        }}/><button type="button" data-blok-chat-attach="" aria-label="Joindre des fichiers" title="Joindre des fichiers" disabled={running || reading}
          onClick={() => picker.current?.click()}><Icon icon={Plus} size={18}/></button></>}
        <span data-blok-chat-provider="">
          <button type="button" ref={trigger} value={selected} disabled={!providers.length}
            data-blok-chat-provider-trigger="" title={label} aria-label="Moteur IA" aria-describedby={labelId}
            aria-haspopup="menu" aria-expanded={!!menu} aria-controls={menu ? labelId + '-menu' : undefined}
            onClick={() => openModels()} onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); openModels(event.key === 'ArrowUp');
              }
            }}><span id={labelId}>{label}</span></button>
          <Icon icon={ChevronDown} size={14}/>
        </span>
        <button ref={submit} type="submit" data-blok-chat-submit="" aria-label={running ? 'Arrêter la réponse' : options.sendLabel ?? 'Envoyer'}
          disabled={running ? !options.onStop : reading || (!hasText && !attachments.length) || !providers.length}><Icon icon={running ? Square : ArrowUp}/></button>
      </div>
    </>));
  }
  const setProviders = (next: readonly ChatProvider[], preferred = selected) => {
    menu?.hide();
    providers = next;
    selected = next.some(item => item.id === preferred) ? preferred : next[0]?.id ?? '';
    render();
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    if (running) { options.onStop?.(); return; }
    const message = input.current!.value.trim();
    if (reading || !selected || (!message && !attachments.length)) return;
    if (attachments.length) {
      let prompt = message || 'Analyse les fichiers joints.';
      if (!message && attachments.every(item => item.kind === 'image'))
        prompt = attachments.length === 1 ? 'Décris cette image.' : 'Décris ces images.';
      options.onSend(prompt, selected, attachments);
      setAttachments([]);
    } else options.onSend(message, selected);
    setText('');
  };
  element.addEventListener('submit', onSubmit);
  setProviders(providers);
  syncInput();
  return {
    element, field: input.current!, submit: submit.current!, setText, setProviders, getAttachments: () => attachments, setAttachments,
    focus: () => input.current?.focus(),
    setRunning(next) {
      if (running === next) return;
      running = next;
      element.toggleAttribute('data-running', next);
      render();
    },
    destroy() {
      destroyed = true;
      revision++;
      menu?.destroy();
      menu = null;
      element.removeEventListener('submit', onSubmit);
      root.unmount();
    },
  };
};
