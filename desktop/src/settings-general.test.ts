import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {mountSettingsPanel} from './settings-panels';
import {must} from './test-helpers';

const base = {kind: 'general', version: 'Blok 2.1.0 · App 0.1.0', workspace: 'Nexenture'} as const;

function mount(panel: Parameters<typeof mountSettingsPanel>[1]) {
  const host = document.createElement('div');
  document.body.append(host);
  return {host, panel: mountSettingsPanel(host, panel)};
}

const button = (host: HTMLElement, text: string): HTMLButtonElement =>
  must([...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text));

/** React garde un cache de la valeur : écrire `.value` directement l'endort. */
function type(field: HTMLInputElement, value: string): void {
  const write = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'value setter');
  write.call(field, value);
  field.dispatchEvent(new Event('input', {bubbles: true}));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('shows a local workspace as read-only, with no identifier and nothing to rename', () => {
  const {host, panel} = mount({...base});
  try {
    expect(host.querySelector('h1')?.textContent).toBe('Général');
    expect(host.textContent).toContain('Nexenture');
    expect(host.textContent).toContain('Sur cet appareil');
    expect(host.querySelector('[data-desktop-settings-workspace-name]')).toBeNull();
    expect(host.querySelector('[data-setting="workspace-id"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-version]')?.textContent).toBe(base.version);
  } finally { panel.destroy(); }
});

it('copies the workspace identifier a remote space exposes', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {...navigator, clipboard: {writeText}});
  const {host, panel} = mount({...base, remoteServer: 'https://blok.test', workspaceId: '94c8fe6e-5828'});
  try {
    expect(host.querySelector('[data-setting="workspace-id"]')?.textContent).toContain('94c8fe6e-5828');
    button(host, 'Copier').click();
    expect(writeText).toHaveBeenCalledWith('94c8fe6e-5828');
    await vi.waitFor(() => expect(host.textContent).toContain('Identifiant copié'));
  } finally { panel.destroy(); }
});

it('renames the workspace once the name actually changed, and says so', async () => {
  const rename = vi.fn().mockResolvedValue(undefined);
  const {host, panel} = mount({...base, remoteServer: 'https://blok.test', workspaceId: 'w1', rename});
  try {
    const field = must(host.querySelector<HTMLInputElement>('[data-desktop-settings-workspace-name]'));
    expect(field.value).toBe('Nexenture');
    // Rien à enregistrer tant que le nom est le même : le bouton reste fermé.
    expect(button(host, 'Enregistrer').disabled).toBe(true);
    type(field, '  Jardin  ');
    expect(button(host, 'Enregistrer').disabled).toBe(false);
    button(host, 'Enregistrer').click();
    expect(rename).toHaveBeenCalledWith('Jardin');
    await vi.waitFor(() => expect(host.textContent).toContain('Nom enregistré'));
    expect(button(host, 'Enregistrer').disabled).toBe(true);
  } finally { panel.destroy(); }
});

it('refuses an empty name without calling the server', () => {
  const rename = vi.fn().mockResolvedValue(undefined);
  const {host, panel} = mount({...base, remoteServer: 'https://blok.test', workspaceId: 'w1', rename});
  try {
    const field = must(host.querySelector<HTMLInputElement>('[data-desktop-settings-workspace-name]'));
    type(field, '   ');
    expect(button(host, 'Enregistrer').disabled).toBe(true);
    expect(rename).not.toHaveBeenCalled();
  } finally { panel.destroy(); }
});

it('keeps the typed name and explains itself when the server refuses', async () => {
  const rename = vi.fn().mockRejectedValue(new Error('Administrator required'));
  const {host, panel} = mount({...base, remoteServer: 'https://blok.test', workspaceId: 'w1', rename});
  try {
    const field = must(host.querySelector<HTMLInputElement>('[data-desktop-settings-workspace-name]'));
    type(field, 'Jardin');
    button(host, 'Enregistrer').click();
    await vi.waitFor(() => expect(host.textContent).toContain('Le nom n’a pas pu être enregistré.'));
    expect(field.value).toBe('Jardin');
    expect(button(host, 'Enregistrer').disabled).toBe(false);
  } finally { panel.destroy(); }
});
