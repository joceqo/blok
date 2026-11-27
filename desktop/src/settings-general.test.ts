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

const find = (host: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text);

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
    // Rien à enregistrer tant que le nom est le même : le bouton n'est pas là.
    expect(find(host, 'Enregistrer')).toBeUndefined();
    type(field, '  Jardin  ');
    button(host, 'Enregistrer').click();
    expect(rename).toHaveBeenCalledWith('Jardin');
    await vi.waitFor(() => expect(host.textContent).toContain('Nom enregistré'));
    expect(find(host, 'Enregistrer')).toBeUndefined();
  } finally { panel.destroy(); }
});

it('refuses an empty name without calling the server', () => {
  const rename = vi.fn().mockResolvedValue(undefined);
  const {host, panel} = mount({...base, remoteServer: 'https://blok.test', workspaceId: 'w1', rename});
  try {
    const field = must(host.querySelector<HTMLInputElement>('[data-desktop-settings-workspace-name]'));
    type(field, '   ');
    expect(find(host, 'Enregistrer')).toBeUndefined();
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
    // Le bouton reste offert : la correction est à un clic, pas à retaper.
    expect(find(host, 'Enregistrer')).toBeDefined();
  } finally { panel.destroy(); }
});

const mailSwitch = (host: HTMLElement): HTMLButtonElement =>
  must(host.querySelector<HTMLButtonElement>('[data-setting="workspace-mail"] [role=switch]'));

it('offers no workspace e-mail switch where there is no server to send them', () => {
  const {host, panel} = mount({...base});
  try {
    expect(host.querySelector('[data-setting="workspace-mail"]')).toBeNull();
    expect(host.textContent).not.toContain('E-mails');
  } finally { panel.destroy(); }
});

it('waits for the workspace answer before letting an administrator flip it', async () => {
  const read = vi.fn().mockResolvedValue(false);
  const write = vi.fn().mockResolvedValue(undefined);
  const {host, panel} = mount({...base, remoteServer: 'https://blok.test', workspaceId: 'w1', mail: {read, write}});
  try {
    // Tant que la réponse n'est pas là, le commutateur ne ment pas sur l'état.
    expect(mailSwitch(host).disabled).toBe(true);
    await vi.waitFor(() => expect(mailSwitch(host).disabled).toBe(false));
    expect(mailSwitch(host).getAttribute('aria-checked')).toBe('false');
    mailSwitch(host).click();
    expect(write).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(mailSwitch(host).getAttribute('aria-checked')).toBe('true'));
  } finally { panel.destroy(); }
});

it('puts the workspace e-mail switch back when the server refuses it', async () => {
  const read = vi.fn().mockResolvedValue(true);
  // L'écriture ne se décide qu'au moment choisi : sans ça, le retour arrière
  // arrive si vite que le test ne verrait jamais la position optimiste.
  let refuse = (_reason: Error): void => {};
  const write = vi.fn().mockReturnValue(new Promise<void>((_resolve, reject) => { refuse = reject; }));
  const {host, panel} = mount({...base, remoteServer: 'https://blok.test', workspaceId: 'w1', mail: {read, write}});
  try {
    await vi.waitFor(() => expect(mailSwitch(host).getAttribute('aria-checked')).toBe('true'));
    mailSwitch(host).click();
    await vi.waitFor(() => expect(mailSwitch(host).getAttribute('aria-checked')).toBe('false'));
    refuse(new Error('Administrator required'));
    await vi.waitFor(() => expect(mailSwitch(host).getAttribute('aria-checked')).toBe('true'));
    expect(host.textContent).toContain('Le réglage n’a pas pu être enregistré.');
  } finally { panel.destroy(); }
});

const iconTrigger = (host: HTMLElement): HTMLButtonElement =>
  must(host.querySelector<HTMLButtonElement>('[data-setting="workspace-icon"] .team-icon-trigger'));

it('shows no icon control where nothing can store one', () => {
  const {host, panel} = mount({...base});
  try {
    expect(host.querySelector('[data-setting="workspace-icon"]')).toBeNull();
  } finally { panel.destroy(); }
});

it('falls back to the workspace initial until an icon is chosen', () => {
  const {host, panel} = mount({...base, icon: {value: '', write: vi.fn()}});
  try {
    expect(iconTrigger(host).textContent).toBe('N');
  } finally { panel.destroy(); }
});

it('shows the chosen icon and hands a new one to the server', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const {host, panel} = mount({...base, icon: {value: '🌱', write}});
  try {
    expect(iconTrigger(host).textContent).toBe('🌱');
    iconTrigger(host).click();
    // L'onglet Icônes s'ouvre en premier et ne demande aucun chargement.
    const choice = await vi.waitFor(() => must(document.querySelector<HTMLButtonElement>('.team-icon-grid button')));
    const picked = must(choice.getAttribute('aria-label'));
    choice.click();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^icon:/);
    expect(picked).toBeTruthy();
  } finally { panel.destroy(); }
});

it('puts the former icon back when the server refuses the new one', async () => {
  const write = vi.fn().mockRejectedValue(new Error('Administrator required'));
  const {host, panel} = mount({...base, icon: {value: '🌱', write}});
  try {
    iconTrigger(host).click();
    (await vi.waitFor(() => must(document.querySelector<HTMLButtonElement>('.team-icon-grid button')))).click();
    // L'avertissement d'abord : l'icône optimiste et celle d'avant se
    // ressemblent trop pour prouver quoi que ce soit toutes seules.
    await vi.waitFor(() => expect(host.textContent).toContain('L’icône n’a pas pu être enregistrée.'));
    expect(iconTrigger(host).textContent).toBe('🌱');
  } finally { panel.destroy(); }
});

it('puts the name before the icon, the way Notion reads top to bottom', () => {
  const {host, panel} = mount({...base, rename: vi.fn(), icon: {value: '', write: vi.fn()}});
  try {
    const order = [...host.querySelectorAll<HTMLElement>('[data-setting]')].map(node => node.dataset.setting);
    expect(order.slice(0, 2)).toEqual(['workspace-name', 'workspace-icon']);
  } finally { panel.destroy(); }
});

it('picks the icon colour from a palette, not from a system dropdown', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const {host, panel} = mount({...base, icon: {value: '', write}});
  try {
    iconTrigger(host).click();
    await vi.waitFor(() => must(document.querySelector('.team-icon-grid button')));
    // Le menu natif ouvrait une liste au thème du système, rangée bleue
    // comprise, qu'aucune feuille de style de l'application n'atteint.
    expect(document.querySelector('select')).toBeNull();
    // La palette tient dans un panneau : six pastilles dans la rangée
    // pousseraient le champ de filtre dehors.
    expect(document.querySelector('.team-icon-colors')).toBeNull();
    const opener = must(document.querySelector<HTMLButtonElement>('.team-icon-color-trigger'));
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    opener.click();
    const swatches = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('.team-icon-colors button')];
      expect(found).toHaveLength(6);
      return found;
    });
    expect(swatches.map(node => node.getAttribute('aria-label'))).toEqual(['Gris', 'Bleu', 'Vert', 'Orange', 'Rouge', 'Violet']);
    expect(swatches.filter(node => node.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    must(swatches.find(node => node.getAttribute('aria-label') === 'Vert')).click();
    // Choisir referme le panneau, et la grille se redessine avant qu'on y pioche.
    await vi.waitFor(() => expect(document.querySelector('.team-icon-colors')).toBeNull());
    must(document.querySelector<HTMLButtonElement>('.team-icon-grid button')).click();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^icon:[a-z]+:green$/);
  } finally { panel.destroy(); }
});
