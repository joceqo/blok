import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mountAgentAssistant,type AgentAssistantHandle} from '../../../src/shell/agent-assistant';
import type {AgentModel} from '../../../types/api';
const cli=vi.hoisted(()=>({inspect:vi.fn(),model:vi.fn()}));
vi.mock('../../../src/shell/agent-model',async(importOriginal)=>({...await importOriginal<typeof import('../../../src/shell/agent-model')>(),inspectCli:cli.inspect,createCliAgentModel:cli.model}));
const mounted: AgentAssistantHandle[]=[];
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();cli.inspect.mockImplementation(async(command)=>({command,installed:true,connected:true,version:'1'}));cli.model.mockReturnValue(async()=>({content:[{type:'text',text:'CLI answer'}],stop_reason:'end_turn'}));});
afterEach(()=>{mounted.splice(0).forEach(handle=>handle.destroy());document.body.replaceChildren();localStorage.clear();});
function mount(options: Parameters<typeof mountAgentAssistant>[0]) {const handle=mountAgentAssistant(options);mounted.push(handle);document.body.append(handle.element);handle.open();return handle;}
function ask(handle:AgentAssistantHandle,text='Question'){const field=handle.element.querySelector<HTMLTextAreaElement>('textarea')!;field.value=text;field.dispatchEvent(new Event('input',{bubbles:true}));handle.element.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
describe('host assistant provider adapters',()=>{
  it('opens the editor separately from chat and immediately hides the action on permission loss', async()=>{
    const editPage={available:vi.fn(()=>true),open:vi.fn()};
    const handle=mount({getPageText:()=>'',openSettings:vi.fn(),editPage,listProviders:async()=>[{id:'openai:test',label:'OpenAI'}]});
    await handle.refreshProviders();
    const edit=handle.element.querySelector<HTMLButtonElement>('[data-blok-agent-edit-page]')!;
    expect(edit.hidden).toBe(false);
    edit.click();
    expect(editPage.open).toHaveBeenCalledOnce();
    expect(handle.element.querySelector<HTMLElement>('[data-blok-agent-panel]')!.hidden).toBe(true);
    editPage.available.mockReturnValue(false);
    handle.refreshPageActions();
    expect(edit.hidden).toBe(true);
    edit.click();
    expect(editPage.open).toHaveBeenCalledOnce();
  });
  it('keeps opaque model IDs through composer selection and renders the captured provider label',async()=>{
    const response: AgentModel=vi.fn(async()=>({content:[{type:'text',text:'OpenAI answer'}],stop_reason:'end_turn'}));
    const modelFor=vi.fn(()=>response), selected=vi.fn();
    const handle=mount({getPageText:()=>'',openSettings:()=>undefined,listProviders:async()=>[{id:'openai:gpt-model',label:'GPT model'},{id:'openai:another',label:'Another model'}],preferredProvider:()=> 'openai:gpt-model',modelFor,onProviderSelected:selected});
    await handle.refreshProviders();expect(cli.inspect).not.toHaveBeenCalled();
    const choice=handle.element.querySelector<HTMLButtonElement>('[data-blok-chat-provider-trigger]')!;expect(choice.value).toBe('openai:gpt-model');
    choice.click();document.querySelector<HTMLElement>('[data-blok-item-name="openai:another"]')!.click();expect(selected).toHaveBeenCalledWith('openai:another');
    await handle.refreshProviders();expect(choice.value).toBe('openai:another');
    ask(handle);
    await vi.waitFor(()=>expect(handle.element.textContent).toContain('OpenAI answer'));
    expect(modelFor).toHaveBeenCalledWith('openai:another',expect.any(Function));
    expect(handle.element.querySelector('[data-blok-agent-turn]')?.textContent).toContain('Another model');
    expect(cli.model).not.toHaveBeenCalled();
  });
  it('refreshes host providers through the public handle and settings event, removing revoked models',async()=>{
    let providers=[{id:'openai:first',label:'First'}];
    const handle=mount({getPageText:()=>'',openSettings:()=>undefined,listProviders:async()=>providers});await handle.refreshProviders();
    providers=[{id:'openai:second',label:'Second'}];window.dispatchEvent(new Event('blok:ai-settings-changed'));
    await vi.waitFor(()=>expect(handle.element.querySelector<HTMLButtonElement>('[data-blok-chat-provider-trigger]')!.value).toBe('openai:second'));
    providers=[];await handle.refreshProviders();expect(handle.element.querySelector<HTMLButtonElement>('[data-blok-chat-provider-trigger]')!.disabled).toBe(true);
  });
  it('retains default connected CLI discovery and the existing CLI model adapter',async()=>{
    const handle=mount({getPageText:()=>'',openSettings:()=>undefined,preferredProvider:()=> 'claude'});await handle.refreshProviders();
    expect(handle.element.querySelector<HTMLButtonElement>('[data-blok-chat-provider-trigger]')!.value).toBe('claude');ask(handle);
    await vi.waitFor(()=>expect(handle.element.textContent).toContain('CLI answer'));expect(cli.model).toHaveBeenCalledWith({command:'claude'});
  });
  it('never passes an opaque host ID to the default CLI executor',async()=>{
    const handle=mount({getPageText:()=>'',openSettings:()=>undefined,listProviders:async()=>[{id:'openai:private',label:'OpenAI'}]});await handle.refreshProviders();ask(handle);
    await vi.waitFor(()=>expect(handle.element.textContent).toContain('nécessite un adaptateur'));
    expect(cli.model).not.toHaveBeenCalled();
  });
  it('uses a searchable real core menu for model catalogs and keeps Escape local to the menu',async()=>{
    const providers=Array.from({length:12},(_,i)=>({id:`openai:model-${i}`,label:`Model ${i}`}));
    const handle=mount({getPageText:()=>'',openSettings:()=>undefined,listProviders:async()=>providers});await handle.refreshProviders();
    handle.element.querySelector<HTMLButtonElement>('[data-blok-chat-provider-trigger]')!.click();
    expect(document.querySelector('[data-blok-chat-model-menu] input')).not.toBeNull();expect(handle.element.querySelector('select')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    expect(handle.element.querySelector<HTMLElement>('[data-blok-agent-panel]')!.hidden).toBe(false);
    expect(handle.element.querySelector('[data-blok-chat-provider-trigger]')?.getAttribute('aria-expanded')).toBe('false');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));expect(handle.element.querySelector<HTMLElement>('[data-blok-agent-panel]')!.hidden).toBe(true);
  });
  it('handles discovery errors without exposing stale selectable models',async()=>{
    const handle=mount({getPageText:()=>'',openSettings:()=>undefined,listProviders:async()=>{throw new Error('Session expirée');}});await handle.refreshProviders();
    expect(handle.element.querySelector<HTMLButtonElement>('[data-blok-chat-provider-trigger]')!.disabled).toBe(true);expect(handle.element.textContent).toContain('Session expirée');
  });
});

it('sends only fresh search results, links the source page and omits sourced turns from later requests', async () => {
  const find = vi.fn().mockResolvedValue([{id:'p1', title:'Budget', excerpt:'Trente euros'}]);
  const open = vi.fn();
  const model = vi.fn<AgentModel>().mockResolvedValue({content:[{type:'text',text:'Trente [1]'}],stop_reason:'end_turn'});
  const handle = mount({ getPageText:()=>'Page active', openSettings:()=>{}, workspaceSearch:{find,open},
    listProviders:async()=>[{id:'model',label:'Modèle'}], modelFor:()=>model });
  expect(handle.element.querySelector('[data-blok-workspace-search], [data-blok-chat-page-context]')).toBeNull();
  await handle.refreshProviders();
  ask(handle, 'Quel budget ?');
  await vi.waitFor(() => expect(handle.element.querySelector('[data-blok-answer-sources] button')).toBeTruthy());
  expect(find).toHaveBeenCalledWith('Quel budget ?', expect.any(AbortSignal));
  expect(JSON.stringify(model.mock.calls[0]![0].messages)).toContain('Trente euros');
  handle.element.querySelector<HTMLButtonElement>('[data-blok-answer-sources] button')!.click();
  expect(open).toHaveBeenCalledWith('p1');
  ask(handle, 'Résume cette page');
  await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(2));
  expect(find).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(model.mock.calls[1]![0].messages)).toContain('Page active');
  expect(JSON.stringify(model.mock.calls[1]![0].messages)).not.toContain('Trente');
});

it('answers an empty workspace search locally and keeps failures distinct from no matches', async () => {
  const find = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Recherche indisponible'));
  const model = vi.fn<AgentModel>();
  const handle = mount({getPageText: () => '', openSettings: vi.fn(),
    workspaceSearch: {find, open: vi.fn()}, modelFor: () => model});
  await handle.refreshProviders();
  ask(handle, 'Combien de lunes a Saturne ?');
  await vi.waitFor(() => expect(handle.element.textContent).toContain('Je n’ai trouvé aucun passage pertinent'));
  expect(handle.element.querySelector('[data-blok-answer-sources]')).toBeNull();
  expect(model).not.toHaveBeenCalled();
  ask(handle, 'Et Jupiter ?');
  await vi.waitFor(() => expect(handle.element.querySelector('[role=alert]')?.textContent).toContain('Recherche indisponible'));
  expect(model).not.toHaveBeenCalled();
});

it('can still answer from the included current page when the space returns no hits', async () => {
  const model = vi.fn<AgentModel>().mockResolvedValue({content:[{type:'text',text:'Le départ est vendredi.'}],stop_reason:'end_turn'});
  const handle = mount({getPageText: () => 'Le départ est vendredi.', openSettings: vi.fn(),
    workspaceSearch: {find: async () => [], open: vi.fn()}, modelFor: () => model});
  await handle.refreshProviders();
  ask(handle, 'Quel jour ?');
  await vi.waitFor(() => expect(handle.element.textContent).toContain('Le départ est vendredi.'));
  expect(JSON.stringify(model.mock.calls[0][0].messages)).toContain('vendredi');
  expect(handle.element.querySelector('[data-blok-answer-sources]')).toBeNull();
});

it.each(['INSUFFICIENT_EVIDENCE', 'Le montant est de 300 €.', 'Le montant est de 300 € [9].'])(
  'abstains when the model cannot support its answer from the workspace (%s)', async answer => {
    const model = vi.fn<AgentModel>().mockResolvedValue({content:[{type:'text',text:answer}],stop_reason:'end_turn'});
    const handle = mount({getPageText: () => '', openSettings: vi.fn(),
      workspaceSearch: {find: async () => [{id:'rh',title:'Départ',excerpt:'Un entretien est prévu.'}], open: vi.fn()},
      modelFor: () => model});
    await handle.refreshProviders();
    ask(handle, 'Quel est le montant des indemnités ?');
    await vi.waitFor(() => expect(handle.element.textContent).toContain('Les passages consultés ne donnent pas assez'));
    expect(handle.element.querySelector('[data-blok-answer-sources]')).toBeNull();
  },
);

it('opens a cited source at the block the match came from', async () => {
  const find = vi.fn().mockResolvedValue([
    { id:'p0', title:'Passage voisin', excerpt:'Une autre espèce' },
    { id:'p1', title:'Compte rendu', excerpt:'La marmotte dort', blockId:'b-cible' },
    { id:'p2', title:'Page sans bloc', excerpt:'Trouvée par son titre' },
  ]);
  const open = vi.fn();
  const model = vi.fn<AgentModel>().mockResolvedValue({content:[{type:'text',text:'Oui [2, 3]'}],stop_reason:'end_turn'});
  const handle = mount({ getPageText:()=>'', openSettings:()=>{}, workspaceSearch:{find,open},
    listProviders:async()=>[{id:'model',label:'Modèle'}], modelFor:()=>model });
  await handle.refreshProviders();
  ask(handle, 'Où dort la marmotte ?');
  await vi.waitFor(() => expect(handle.element.querySelectorAll('[data-blok-answer-sources] button')).toHaveLength(2));
  const links = handle.element.querySelectorAll<HTMLButtonElement>('[data-blok-answer-sources] button');

  expect(links[0]!.textContent).toBe('[2] Compte rendu');
  links[0]!.click();
  expect(open).toHaveBeenCalledWith('p1', 'b-cible');
  // Nothing to cite: the page opens as before, with no second argument to ignore.
  links[1]!.click();
  expect(open).toHaveBeenLastCalledWith('p2');
});

it('finds conversations in this session and reopens the selected one', async () => {
  const handle = mount({ getPageText: () => 'Contexte du document', openSettings: () => undefined });
  await handle.refreshProviders();
  expect(handle.searchableChats()).toEqual([]);
  ask(handle, 'Préparer les entretiens');
  await vi.waitFor(() => expect(handle.searchableChats()[0]?.excerpt).toContain('CLI answer'));
  const [original] = handle.searchableChats();
  expect(original.title).toBe('Préparer les entretiens');
  expect(original.excerpt).not.toContain('Contexte du document');
  handle.element.querySelector<HTMLButtonElement>('[data-blok-agent-new]')!.click();
  handle.close();
  handle.openChat(original.id);
  expect(handle.element.querySelector<HTMLElement>('[data-blok-agent-panel]')!.hidden).toBe(false);
  expect(handle.element.querySelector('[data-blok-agent-history]')?.getAttribute('aria-label')).toContain(original.title);
});

it('reopens a matching draft without sending it or replacing another draft', async () => {
  const handle = mount({getPageText:()=>'',openSettings:()=>{},listProviders:async()=>[]});
  const opener = handle.element.querySelector<HTMLButtonElement>('[data-blok-agent-toggle]')!;
  const field = handle.element.querySelector<HTMLTextAreaElement>('textarea')!;
  handle.close(); opener.focus(); opener.click();
  field.value = 'Préparer la réunion'; field.dispatchEvent(new Event('input',{bubbles:true}));
  handle.element.querySelector<HTMLButtonElement>('[data-blok-agent-new]')!.click();
  expect(field.value).toBe('');
  field.value = 'Deuxième brouillon'; field.dispatchEvent(new Event('input',{bubbles:true}));
  const history = handle.element.querySelector<HTMLButtonElement>('[data-blok-agent-history]')!;
  history.click();
  const search = handle.element.querySelector<HTMLInputElement>('[data-blok-agent-menu=history] input')!;
  expect(document.activeElement).toBe(search);
  search.value = 'reunion'; search.dispatchEvent(new Event('input',{bubbles:true}));
  expect(handle.element.querySelectorAll('[data-agent-chat-id]')).toHaveLength(1);
  search.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  expect(field.value).toBe('Préparer la réunion');
  expect(document.activeElement).toBe(field);
  history.click();
  search.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  expect(document.activeElement).toBe(history);
  history.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  expect(document.activeElement).toBe(opener);
  expect(cli.model).not.toHaveBeenCalled();
});

it('switches all three views without remounting the composer or interrupting the active request', async () => {
  let finish!: (value: Awaited<ReturnType<AgentModel>>) => void;
  const model = vi.fn<AgentModel>(() => new Promise(resolve => { finish = resolve; }));
  const handle = mount({getPageText: () => '', openSettings: vi.fn(), modelFor: () => model});
  await handle.refreshProviders();
  const panel = handle.element.querySelector<HTMLElement>('[data-blok-agent-panel]')!;
  const field = panel.querySelector('textarea')!;
  const change = async (view: string) => {
    const options = panel.querySelector<HTMLButtonElement>('[data-blok-chat-options]')!;
    options.click();
    await vi.waitFor(() => expect(panel.querySelector('[data-blok-agent-mode-option]')).toBeTruthy());
    const button = panel.querySelector<HTMLButtonElement>(`[data-blok-agent-mode-option="${view}"]`)!;
    expect(button.closest('[hidden]')).toBeNull();
    button.click();
    await vi.waitFor(() => expect(options.getAttribute('aria-expanded')).toBe('false'));
    expect(panel.dataset.blokAgentMode).toBe(view);
    expect(panel.querySelector('textarea')).toBe(field);
  };
  field.value = 'Un brouillon à conserver';
  field.dispatchEvent(new Event('input', {bubbles:true}));
  await change('floating');
  await change('full');
  expect(field.value).toBe('Un brouillon à conserver');
  ask(handle, field.value);
  await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
  await change('side');
  expect(model.mock.calls[0][0].signal.aborted).toBe(false);
  finish({content:[{type:'text',text:'Réponse dans la même conversation'}],stop_reason:'end_turn'});
  await vi.waitFor(() => expect(panel.textContent).toContain('Réponse dans la même conversation'));
  expect(panel.querySelectorAll('[data-blok-agent-turn]')).toHaveLength(1);
  await change('full');
  handle.close();
  handle.open();
  expect(panel.getAttribute('role')).toBe('region');
  expect(panel.querySelectorAll('header > button')).toHaveLength(4);
  expect(localStorage.getItem('blok.shell.agent.panel-mode')).toBe('full');
});

it('copies a restorable conversation without storing raw RAG context', async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  const links = {copy, save:vi.fn(), read:vi.fn()};
  const options = {getPageText:()=>'Hidden page text', openSettings:vi.fn(), chatLinks:links};
  const first = mount(options);
  await first.refreshProviders();
  ask(first,'Résume cette page');
  await vi.waitFor(() => expect(first.element.textContent).toContain('CLI answer'));
  first.element.querySelector<HTMLButtonElement>('[data-blok-chat-options]')!.click();
  await vi.waitFor(() => expect(first.element.querySelector('[role=menu]')).toBeTruthy());
  const item = [...first.element.querySelectorAll<HTMLElement>('[role=menuitem]')].find(el=>el.textContent === 'Copier le lien')!;
  item.click();
  await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
  const [record] = copy.mock.calls[0];
  expect(JSON.stringify(record)).not.toContain('Hidden page text');
  expect(record.turns[0].answer).toBe('CLI answer');
  links.read.mockReturnValue(record);
  const second = mount(options);
  second.openChat(record.id);
  expect(second.element.textContent).toContain('CLI answer');
});

it('keeps dropped images in the draft until send and answers even without a workspace match', async () => {
  const model = vi.fn<AgentModel>().mockResolvedValue({content:[{type:'text',text:'Une image.'}],stop_reason:'end_turn'});
  const find = vi.fn(async () => []);
  const handle = mount({acceptAttachments:true, getPageText:() => '', openSettings:vi.fn(), modelFor:() => model,
    workspaceSearch:{find,open:vi.fn()}});
  await handle.refreshProviders();
  const form = handle.element.querySelector('form')!;
  const drop = () => {
    const event = new Event('drop', {bubbles:true,cancelable:true});
    Object.assign(event, {dataTransfer:{types:['Files'],files:[new File(['abc'], 'capture.png', {type:'image/png'})]}});
    form.dispatchEvent(event);
  };
  drop();
  const remove = () => form.querySelector<HTMLButtonElement>('[aria-label="Retirer capture.png"]');
  await vi.waitFor(() => expect(remove()).toBeTruthy());
  remove()!.click();
  expect(form.querySelector('img')).toBeNull();
  drop();
  await vi.waitFor(() => expect(remove()).toBeTruthy());
  expect(model).not.toHaveBeenCalled();
  ask(handle, 'Que vois-tu ?');
  await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
  expect(model.mock.calls[0][0].images).toEqual(['data:image/png;base64,YWJj']);
  expect(find).not.toHaveBeenCalled();
  expect(form.querySelector('img')).toBeNull();
});

it('reads the text of dropped Markdown and preserves the draft when a binary file is rejected', async () => {
  const model = vi.fn<AgentModel>().mockResolvedValue({content:[{type:'text',text:'Lu.'}],stop_reason:'end_turn'});
  const handle = mount({acceptAttachments:true, getPageText:() => '', openSettings:vi.fn(), modelFor:() => model});
  await handle.refreshProviders();
  const form = handle.element.querySelector('form')!;
  const drop = (file: File) => {
    const event = new Event('drop', {bubbles:true, cancelable:true});
    Object.assign(event, {dataTransfer:{types:['Files'],files:[file]}});
    form.dispatchEvent(event);
  };
  drop(new File(['# Dossier\nÉchéance vendredi.'], 'projet.md'));
  await vi.waitFor(() => expect(form.querySelector('[aria-label="Retirer projet.md"]')).toBeTruthy());
  drop(new File(['\u0000binary'], 'programme.exe'));
  await vi.waitFor(() => expect(form.querySelector('[role="alert"]')).toBeTruthy());
  expect(model).not.toHaveBeenCalled();
  ask(handle, 'Quelle est l’échéance ?');
  await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
  expect(model.mock.calls[0][0].messages.at(-1)?.content).toContain('Échéance vendredi.');
  expect(model.mock.calls[0][0].images).toEqual([]);
});

it('keeps retrieved passages visible in activity independently of the final citations', async () => {
  const open = vi.fn();
  const model = vi.fn<AgentModel>().mockResolvedValue({content:[{type:'text',text:'Vendredi [1].'}],stop_reason:'end_turn'});
  const handle = mount({getPageText:()=>'Planning', getPageTitle:()=>'Calendrier', openSettings:vi.fn(),
    workspaceSearch:{find:async()=>[
      {id:'a',blockId:'1',title:'Départ',excerpt:'Vendredi'},
      {id:'b',blockId:'2',title:'Budget',excerpt:'Confidentiel'},
    ],open},modelFor:()=>model});
  await handle.refreshProviders();
  ask(handle,'Quel jour partons-nous ?');
  await vi.waitFor(()=>expect(handle.element.textContent).toContain('Vendredi [1].'));
  const activity = handle.element.querySelector<HTMLDetailsElement>('details[data-blok-chat-activity]')!;
  expect(activity).toBeTruthy();
  expect(activity.open).toBe(false);
  activity.querySelector('summary')!.click();
  expect(activity.open).toBe(true);
  expect(activity.textContent).toContain('Calendrier');
  expect(activity.textContent).toContain('2 passages trouvés');
  expect(activity.textContent).not.toContain('Confidentiel');
  const budget = [...activity.querySelectorAll('button')].find(b=>b.textContent === 'Budget')!;
  budget.click();
  expect(open).toHaveBeenCalledWith('b','2');
  expect(handle.element.querySelector('[data-blok-answer-sources]')?.textContent).not.toContain('Budget');
});

it('shows reported progress live and preserves its disclosure without adding a search for a greeting', async () => {
  let finish!: () => void;
  let report!: (status:string) => void;
  const pending = new Promise<void>(resolve => {finish = resolve;});
  const find = vi.fn(async () => []);
  const handle = mount({getPageText:()=>'Texte privé', openSettings:vi.fn(), workspaceSearch:{find,open:vi.fn()},
    modelFor:(_id, progress) => {report = progress; return async () => {
      progress('Réflexion en cours…');
      await pending;
      return {content:[{type:'text',text:'Bonjour !'}],stop_reason:'end_turn'};
    };}});
  await handle.refreshProviders();
  ask(handle, 'hello');
  const details = handle.element.querySelector<HTMLDetailsElement>('[data-blok-chat-activity]')!;
  await vi.waitFor(()=>expect(details.querySelector('summary .shimmer')?.textContent).toBe('Réflexion en cours…'));
  details.querySelector('summary')!.click();
  report('Recherche sur le Web…');
  expect(details.open).toBe(true);
  expect(details.querySelector('summary')?.textContent).toContain('Recherche sur le Web');
  finish();
  await vi.waitFor(()=>expect(details.querySelector('summary')?.textContent).toBe('Activité'));
  expect(details.open).toBe(true);
  expect(details.querySelector('ol')?.textContent).toContain('Recherche sur le Web');
  expect(details.textContent).not.toContain('Page ouverte');
  expect(find).not.toHaveBeenCalled();
});
