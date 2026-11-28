import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blok } from '../../../src/blok';
import { PageTool as Page } from '../../../src/tools/page';
import { Paragraph } from '../../../src/tools/paragraph';
import type { Blok as Editor } from '../../../types';
import { createAiClient } from '../../../desktop/src/ai-client';
import { pageEditorAssistant } from '../../../desktop/src/editor-assistant';
import { pageAccess } from '../../../desktop/src/page-access';
import type { RemoteWorkspace } from '../../../desktop/src/workspace-registry';

const ref: RemoteWorkspace = {kind:'remote', id:'fixture', name:'Fixture', workspaceId:'team', accountId:'member', server:'https://fixture.test'};
const endpoint = 'https://fixture.test/api/workspaces/team/ai';
const response = (value: unknown) => ({ok:true, json: async () => value});
const config = {effective:{source:'workspace', model:'configured'}};
const insert = (type: string) => ({type:'function_call', call_id:'edit', name:'blok_execute', arguments: JSON.stringify({
  commands:[{name:'block.insert', args:{type, data: type === 'page' ? {} : {text:'Edited by the assistant'}, position:'end'}}],
})});
const done = {type:'message', role:'assistant', content:[{type:'output_text',text:'Done.'}]};
const created = vi.fn();
let editor: Editor;
const mount = async (canEdit: () => boolean) => {
  const scope = pageEditorAssistant(createAiClient(ref), canEdit, () => 'openai:preferred');
  const holder = document.createElement('div');
  document.body.append(holder);
  editor = new Blok({
    holder,
    agent: scope.agent,
    tools: {paragraph: Paragraph, page: {class: Page, config:{create:created}}},
    data: {blocks:[{id:'original',type:'paragraph',data:{text:'Original'}}]},
  }) as unknown as Editor;
  await editor.isReady;
  return scope;
};
const documentTexts = async () => JSON.stringify((await editor.save()).blocks.map(block => block.data.text));

describe('shell editor assistant', () => {
  beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined); });
  afterEach(() => {
    editor?.destroy();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    created.mockClear();
  });
  it('round trips real tool output through the workspace API, edits the page and keeps native Undo', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(config))
      .mockResolvedValueOnce(response({status:'completed',output:[insert('paragraph')]}))
      .mockResolvedValueOnce(response({status:'completed',output:[done]}));
    vi.stubGlobal('fetch', fetch);
    await mount(() => true);
    const run = editor.agent.ask('Add a paragraph');
    expect(await run.result).toMatchObject({status:'done',reply:'Done.'});
    expect(fetch.mock.calls.map(call => call[0])).toEqual([endpoint, endpoint+'/editor-respond', endpoint+'/editor-respond']);
    const first = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(first).toMatchObject({model:'preferred',store:false,stream:false,max_output_tokens:4096});
    expect(first.tools.map((tool: {name:string}) => tool.name).sort()).toEqual(['blok_describe','blok_execute','blok_read']);
    expect(JSON.stringify(first.input)).toContain('Original');
    expect(JSON.parse(fetch.mock.calls[2]![1].body).input).toContainEqual(expect.objectContaining({type:'function_call_output',call_id:'edit'}));
    expect(await documentTexts()).toContain('Edited by the assistant');
    run.end();
    editor.history.undo();
    expect(await documentTexts()).not.toContain('Edited by the assistant');
    expect(await documentTexts()).toContain('Original');
  });
  it('rejects an edit before any context is sent when the account has viewer access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const access = pageAccess({...ref,role:'viewer'}, {page:{level:'full',visibility:'workspace'}});
    await mount(() => access.canEdit('page'));
    expect(() => editor.agent.ask('Change this')).toThrow('modifiable');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('drops a late provider action after navigation and closes the old turn', async () => {
    let finish!: (value: unknown) => void;
    const fetch = vi.fn().mockResolvedValueOnce(response(config)).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    vi.stubGlobal('fetch', fetch);
    const scope = await mount(() => true);
    const run = editor.agent.ask('Edit');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    scope.cancel();
    expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true);
    finish(response({status:'completed',output:[insert('paragraph')]}));
    expect(await run.result).toMatchObject({status:'stopped'});
    expect(await documentTexts()).not.toContain('Edited by the assistant');
    expect(() => run.followUp('Try again')).toThrow('ended');
  });
  it('cannot create a second workspace page through the Page tool', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(config))
      .mockResolvedValueOnce(response({status:'completed',output:[insert('page')]}))
      .mockResolvedValueOnce(response({status:'completed',output:[done]}));
    vi.stubGlobal('fetch', fetch);
    await mount(() => true);
    const run = editor.agent.ask('Create another page');
    await run.result;
    const input = JSON.parse(fetch.mock.calls[2]![1].body).input;
    const toolResult = input.find((item: {type:string}) => item.type === 'function_call_output');
    expect(toolResult.output).toContain('"ok":false');
    expect(created).not.toHaveBeenCalled();
    run.end();
  });
});
