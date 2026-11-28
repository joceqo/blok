import {afterEach, expect, it} from 'vitest';
import {activeWorkspace, initialWorkspace, listWorkspaces, rememberWorkspace, workspaceKey} from './workspace-registry';

afterEach(() => localStorage.clear());

it('lists the device workspace first, even with nothing stored', () => {
  expect(listWorkspaces()).toEqual([initialWorkspace]);
  expect(activeWorkspace()).toEqual(initialWorkspace);
});

it('keeps what was remembered about the device workspace', () => {
  // L'entrée par défaut était recréée depuis la constante à chaque lecture,
  // ce qui jetait tout ce qu'on venait d'écrire sur elle : l'icône choisie
  // était bien enregistrée, et perdue au rechargement suivant.
  rememberWorkspace({...initialWorkspace, icon: '🌱'});

  expect(listWorkspaces()).toEqual([{...initialWorkspace, icon: '🌱'}]);
  expect(activeWorkspace()).toMatchObject({icon: '🌱'});
});

it('never lists the device workspace twice', () => {
  rememberWorkspace({...initialWorkspace, icon: '🌱'});
  rememberWorkspace({kind: 'local', id: 'atelier', name: 'Atelier'});

  const keys = listWorkspaces().map(workspaceKey);
  expect(new Set(keys).size).toBe(keys.length);
  expect(listWorkspaces()[0]).toMatchObject({id: 'default', icon: '🌱'});
});

it('still answers with the workspace the session last opened', () => {
  const atelier = {kind: 'local', id: 'atelier', name: 'Atelier'} as const;
  rememberWorkspace(atelier);
  localStorage.setItem('blok:desktop:active-workspace:v1', workspaceKey(atelier));

  expect(activeWorkspace()).toMatchObject({id: 'atelier'});
});
