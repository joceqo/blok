import { workspaceKey, type WorkspaceRef } from './workspace-registry';

export interface LinkedChat {
  id: string;
  turns: {question: string; answer: string; label: string; sources?: {id: string; title: string; number: number; blockId?: string}[]}[];
}

const prefix = 'blok:linked-chat:v1:';
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export const pendingChat = 'blok:open-linked-chat';
export function parseChatLink(raw: string) {
  const id = raw.slice('blok://chat/'.length);
  return raw.startsWith('blok://chat/') && uuid.test(id) ? id : undefined;
}

export function chatOwner(id: string): string | undefined {
  if (!uuid.test(id)) return;
  const record = localStorage.getItem(prefix + id);
  return record ? JSON.parse(record).owner : undefined;
}

export function chatLinks(ref: WorkspaceRef) {
  const owner = workspaceKey(ref);
  return {
    save(chat: LinkedChat) {
      if (!uuid.test(chat.id)) throw new Error('Discussion invalide.');
      localStorage.setItem(prefix + chat.id, JSON.stringify({owner, chat}));
    },
    read(id: string): LinkedChat | undefined {
      if (!uuid.test(id)) return;
      const record = JSON.parse(localStorage.getItem(prefix + id) ?? 'null');
      return record?.owner === owner && Array.isArray(record.chat?.turns) ? record.chat : undefined;
    },
    async copy(chat: LinkedChat) {
      this.save(chat);
      const url = new URL(location.href);
      url.searchParams.set('chat', chat.id);
      const link = '__TAURI_INTERNALS__' in window ? 'blok://chat/' + chat.id : url.href;
      await navigator.clipboard.writeText(link);
    },
  };
}
