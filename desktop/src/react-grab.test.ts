import {afterEach, describe, expect, it, vi} from 'vitest';

const init = vi.hoisted(() => vi.fn(() => {
  let active = false;
  return {
    registerPlugin: vi.fn(),
    isEnabled: () => true,
    isActive: () => active,
    toggle: () => { active = !active; },
    deactivate: () => { active = false; },
  };
}));
vi.mock('react-grab/core', () => ({init}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); init.mockClear(); document.body.replaceChildren(); delete window.__REACT_GRAB__; });

describe('React Grab in the local demo', () => {
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
  it('identifies the web or native client in both clipboard actions at copy time', async () => {
    vi.stubEnv('VITE_REACT_GRAB', 'true');
    const {loadReactGrab} = await import('./react-grab');
    await loadReactGrab();
    const {hooks} = init.mock.results[0].value.registerPlugin.mock.calls[0][0];
    expect(hooks.transformCopyContent('element')).toContain('Client: Blok Web (navigateur) · espace local');
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    try {
      expect(hooks.transformHtmlContent('<span/>')).toBe('<!-- Client: Blok Desktop (Tauri) · espace local -->\n<span/>');
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps Escape inside inspection until the next distinct press', async () => {
    vi.stubEnv('VITE_REACT_GRAB', 'true');
    const {loadReactGrab} = await import('./react-grab');
    const api = await loadReactGrab();
    const input = document.createElement('input');
    document.body.append(input);
    const dismiss = vi.fn();
    input.addEventListener('keydown', dismiss);
    const press = (init: KeyboardEventInit) => input.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, ...init,
    }));
    press({key: 'G', code: 'KeyG', metaKey: true, shiftKey: true});
    expect(api.isActive()).toBe(true);
    press({key: 'Escape'});
    expect(api.isActive()).toBe(false);
    press({key: 'Escape', repeat: true});
    expect(dismiss).not.toHaveBeenCalled();
    press({key: 'Escape'});
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it('does not load in a regular production build', async () => {
    vi.stubEnv('DEV', false); vi.stubEnv('VITE_REACT_GRAB', 'false');
    const {loadReactGrab, reactGrabAvailable} = await import('./react-grab');
    expect(reactGrabAvailable).toBe(false);
    await expect(loadReactGrab()).rejects.toThrow('pas activé');
    expect(init).not.toHaveBeenCalled();
  });
});
