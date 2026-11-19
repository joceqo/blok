import { afterEach, expect, it, vi } from 'vitest';
import type { OutputData } from '../../types';
import { createRowBodyDrafts, type RowDraftRequest } from './row-body-draft';

const empty: OutputData = {blocks:[{id:'p',type:'paragraph',data:{text:' '}}]};
const content: OutputData = {blocks:[{id:'p',type:'paragraph',data:{text:'First character'}}]};
const hosts: ReturnType<typeof createRowBodyDrafts>[] = [];
afterEach(() => { hosts.splice(0).forEach(host => host.destroy()); localStorage.clear(); document.body.replaceChildren(); });

function harness(scope = 'account:workspace', storage: Storage = localStorage) {
  let change = () => {};
  let body = empty;
  let resolve!: (receipt: {pageId:string}) => void;
  let reject!: (error: Error) => void;
  const create = vi.fn((_request: RowDraftRequest) => new Promise<{pageId:string}>((yes,no) => {resolve=yes;reject=no;}));
  const editor = {isReady:Promise.resolve(),save:vi.fn(async()=>body),destroy:vi.fn()};
  const mountPage = vi.fn(() => ({destroy:vi.fn(),ready:Promise.resolve()}));
  const createEditor = vi.fn((options: {onChange():void;holder:HTMLElement;data:OutputData;readOnly:boolean}) => {
    change=options.onChange;
    body=options.data;
    const input=document.createElement('div'); input.contentEditable=String(!options.readOnly); input.textContent='Draft'; options.holder.append(input);
    return editor;
  });
  const drafts=createRowBodyDrafts({scope,storage,create,createEditor,mountPage,readOnly:()=>false});
  hosts.push(drafts);
  const holder=document.createElement('div'); document.body.append(holder);
  return {drafts,holder,create,editor,mountPage,createEditor,change(data:OutputData){body=data;change();},resolve:()=>resolve({pageId:'body'}),reject:()=>reject(new Error('Lost response'))};
}

it('keeps opening, empty paragraphs and whitespace local without allocation', async () => {
  const h=harness(); h.drafts.mount('physical','row',h.holder);
  h.change(empty); await h.drafts.flush();
  expect(h.create).not.toHaveBeenCalled();
  expect(h.mountPage).not.toHaveBeenCalled();
});

it('persists an immutable first-content snapshot before upload and suspends editing', async () => {
  const h=harness(); h.drafts.mount('physical','row',h.holder);
  h.change(content); await h.drafts.flush();
  expect(h.create).toHaveBeenCalledTimes(1);
  const request=h.create.mock.calls[0]?.[0];
  expect(request).toMatchObject({documentId:'physical',rowId:'row',body:content,operationId:expect.any(String)});
  expect(h.holder.querySelector('[inert]')).not.toBeNull();
  expect(localStorage.length).toBe(1);
  expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).snapshot).toEqual(content);
  expect(h.editor.destroy).not.toHaveBeenCalled();
  h.resolve(); await vi.waitFor(()=>expect(h.mountPage).toHaveBeenCalledWith('body',expect.any(HTMLElement)));
  await vi.waitFor(()=>expect(localStorage.length).toBe(0));
});

it('keeps draft and operation on lost response, close/reopen and retry', async () => {
  const h=harness(); const mounted=h.drafts.mount('physical','row',h.holder);
  h.change(content); await h.drafts.flush();
  const original=h.create.mock.calls[0]?.[0];
  mounted.destroy(); h.reject(); await Promise.resolve(); await Promise.resolve();
  h.drafts.mount('physical','row',h.holder);
  expect(h.drafts.hasDraft('physical','row')).toBe(true);
  await vi.waitFor(()=>expect(h.holder.querySelector('[data-row-draft-retry]')).not.toBeNull());
  h.holder.querySelector<HTMLButtonElement>('[data-row-draft-retry]')?.click();
  await vi.waitFor(()=>expect(h.create).toHaveBeenCalledTimes(2));
  expect(h.create.mock.calls[1]?.[0]).toEqual(original);
  h.resolve(); await vi.waitFor(()=>expect(localStorage.length).toBe(0));
});

it('reloads pending data scoped to account, physical document and row', async () => {
  const h=harness(); h.drafts.mount('physical','row',h.holder);
  h.change(content); await h.drafts.flush();
  const request=h.create.mock.calls[0]?.[0]; h.drafts.destroy();
  const restored=harness(); restored.drafts.mount('physical','row',restored.holder);
  expect(restored.createEditor.mock.calls[0]?.[0].data).toEqual(content);
  restored.holder.querySelector<HTMLButtonElement>('[data-row-draft-retry]')?.click();
  await vi.waitFor(()=>expect(restored.create).toHaveBeenCalledTimes(1));
  expect(restored.create.mock.calls[0]?.[0]).toEqual(request);
  const other=harness('other-account');
  expect(other.drafts.hasDraft('physical','row')).toBe(false);
  expect(restored.drafts.hasDraft('other-physical','row')).toBe(false);
});

it('does not upload when local persistence fails and leaves the draft visible', async () => {
  const storage={getItem:()=>null,setItem:()=>{throw new Error('quota');},removeItem:()=>{},length:0,key:()=>null,clear:()=>{}};
  const h=harness('scope',storage); h.drafts.mount('physical','row',h.holder);
  h.change(content); await h.drafts.flush();
  expect(h.create).not.toHaveBeenCalled();
  expect(h.holder.textContent).toContain('Draft');
  expect(h.holder.textContent).toContain('quota');
});
