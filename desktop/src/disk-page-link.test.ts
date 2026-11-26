import { afterEach, expect, it, vi } from 'vitest';
import { activateWorkspace, rememberWorkspace, type LocalWorkspace } from './workspace-registry';

const {mountDesktop} = vi.hoisted(() => ({mountDesktop:vi.fn()}));
vi.mock('./react-grab', () => ({reactGrabAvailable:false}));
vi.mock('./shell', () => ({mountDesktop, flushDesktop:vi.fn()}));

const first: LocalWorkspace = {kind:'local',id:'first',name:'Premier'};
const second: LocalWorkspace = {kind:'local',id:'second',name:'Deuxième'};

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  localStorage.clear();
  history.replaceState(null, '', '/');
  document.body.replaceChildren();
});

it.each(['web','native'])('mounts the scoped workspace when a %s link opens from a different disk', async (runtime) => {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  for (const ref of [first,second]) {
    rememberWorkspace(ref);
    const index = {pages:[{id:'shared',title:ref.name,parentId:null}], activeId:'shared'};
    localStorage.setItem('blok:workspace:' + ref.id + ':index', JSON.stringify(index));
  }
  activateWorkspace(second);
  const query = 'local=1&workspace=first&view=whiteboard';
  if (runtime === 'native') {
    let pending: string | null = 'blok://page/shared?' + query;
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke:async (command: string, args?: {workspace:string;name:string}) => {
      if (command === 'take_page_link') { const value = pending; pending = null; return value; }
      if (command === 'load_workspace_file' && args) return localStorage.getItem('blok:workspace:' + args.workspace + ':' + args.name);
      return null;
    }});
  } else history.replaceState(null, '', '/?page=shared&' + query);
  await import('./main');
  await vi.waitFor(() => expect(mountDesktop).toHaveBeenCalledWith(root,first));
  expect(new URL(location.href).searchParams.get('view')).toBe('whiteboard');
  expect(localStorage.getItem('blok:desktop:active-workspace:v1')).toBe('local:first');
});
