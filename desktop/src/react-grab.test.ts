import {afterEach, describe, expect, it, vi} from 'vitest';

const init = vi.hoisted(() => vi.fn(() => ({activate: vi.fn(), toggle: vi.fn()})));
vi.mock('react-grab/core', () => ({init}));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); init.mockClear(); document.body.replaceChildren(); delete window.__REACT_GRAB__; });

describe('React Grab in Blok', () => {
  it('loads once in an explicitly enabled production build and supplies DOM source context', async () => {
    vi.stubEnv('DEV', false); vi.stubEnv('VITE_REACT_GRAB', 'true');
    const {loadReactGrab} = await import('./react-grab');
    await Promise.all([loadReactGrab(), loadReactGrab()]);
    expect(init).toHaveBeenCalledOnce();
    const options = (init.mock.calls as unknown as [[{getContent: (elements: Element[]) => string; telemetry: boolean}]])[0][0];
    expect(options.telemetry).toBe(false);
    const section = document.createElement('section'); section.dataset.settingsSource = 'desktop/src/settings.ts';
    const button = document.createElement('button'); button.textContent = 'Connexions'; section.append(button);
    expect(options.getContent([button])).toContain('Source: desktop/src/settings.ts');
    expect(options.getContent([button])).toContain('Connexions');
    const secret = document.createElement('div'); secret.setAttribute('data-desktop-mcp-secret', '');
    const token = document.createElement('code'); token.textContent = 'private-test-token'; secret.append(token);
    expect(options.getContent([token])).not.toContain('private-test-token');
    expect(options.getContent([secret])).toBe('[jeton masqué]');
  });
  it('enables the packaged Tauri inspector and matches its shortcut', async () => {
    vi.stubEnv('DEV', false); vi.stubEnv('VITE_REACT_GRAB', 'false');
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const {loadReactGrab, onReactGrabShortcut, reactGrabAvailable} = await import('./react-grab');
    expect(reactGrabAvailable).toBe(true);
    const api = await loadReactGrab();
    expect(window.__REACT_GRAB__).toBe(api);
    for (const modifier of ['metaKey', 'ctrlKey']) {
      onReactGrabShortcut(new KeyboardEvent('keydown', {[modifier]: true, shiftKey: true, code: 'KeyG'}));
    }
    onReactGrabShortcut(new KeyboardEvent('keydown', {shiftKey: true, code: 'KeyG'}));
    onReactGrabShortcut(new KeyboardEvent('keydown', {metaKey: true, shiftKey: true, code: 'KeyG', repeat: true}));
    expect(api.toggle).toHaveBeenCalledTimes(2);
  });
  it('does not load in a regular production build', async () => {
    vi.stubEnv('DEV', false); vi.stubEnv('VITE_REACT_GRAB', 'false');
    const {loadReactGrab, reactGrabAvailable} = await import('./react-grab');
    expect(reactGrabAvailable).toBe(false);
    await expect(loadReactGrab()).rejects.toThrow('pas activé');
    expect(init).not.toHaveBeenCalled();
  });
});
