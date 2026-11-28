import {afterEach, expect, it, vi} from 'vitest';
import {chatLinks, chatOwner, parseChatLink} from './chat-link';
import type {WorkspaceRef} from './workspace-registry';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
it('copies a private device link and restores the same discussion only for its account and workspace', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {clipboard:{writeText}});
  const workspace:WorkspaceRef = {kind:'local',id:'notes',name:'Notes'};
  const chat = {id:crypto.randomUUID(),turns:[{question:'Quand ?',answer:'Demain.',label:'Codex'}]};
  await chatLinks(workspace).copy(chat);
  const url = writeText.mock.calls[0][0];
  expect(url).toBe('blok://chat/'+chat.id);
  expect(parseChatLink(url)).toBe(chat.id);
  expect(parseChatLink(url+'?extra=1')).toBeUndefined();
  expect(chatOwner(chat.id)).toBe('local:notes');
  expect(chatLinks(workspace).read(chat.id)).toEqual(chat);
  expect(chatLinks({...workspace,id:'other'}).read(chat.id)).toBeUndefined();
});
