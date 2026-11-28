import {afterEach, describe, expect, it, vi} from 'vitest';
import {must, requestBody} from '../test-helpers';
import {CloudClient} from './client';
import {deriveWorkspaceSlug, mountSetupAssistant} from './setup';

function response(data: unknown, status = 200): Response {
  return {ok: status < 400, status, json: async () => data} as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('deriveWorkspaceSlug', () => {
  it('derives a stable slug from a display name', () => {
    expect(deriveWorkspaceSlug('Mon Équipe')).toBe('mon-equipe');
    expect(deriveWorkspaceSlug('  Acme Corp!! ')).toBe('acme-corp');
    expect(deriveWorkspaceSlug('')).toBe('espace');
  });
});

describe('setup assistant', () => {
  function setup(passwordAuthAvailable = false) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ok: true}));
    vi.stubGlobal('fetch', fetch);
    const onClaimed = vi.fn();
    mountSetupAssistant({
      client: new CloudClient({origin: 'http://blok.example.test'}),
      frame: () => document.body,
      run: async (action) => { await action(); },
      passwordAuthAvailable, onClaimed,
    });
    return {
      fetch, onClaimed,
      workspace: must(document.querySelector<HTMLInputElement>('#cloud-workspace-name')),
      admin: must(document.querySelector<HTMLInputElement>('#cloud-admin-name')),
      email: must(document.querySelector<HTMLInputElement>('#cloud-admin-email')),
      form: must(document.querySelector('form')),
    };
  }

  it('claims the instance with the workspace name and hands the admin address to verification', async () => {
    const {fetch, onClaimed, workspace, admin, email, form} = setup();
    workspace.value = '  Bureau Études  ';
    admin.value = ' Alice ';
    email.value = 'alice@example.test';
    form.requestSubmit();
    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledWith(email.value, undefined));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = must(fetch.mock.calls[0]);
    expect(url).toMatch(/\/api\/setup\/claim$/);
    expect(JSON.parse(requestBody(init))).toEqual({
      workspace: {name: 'Bureau Études', slug: 'bureau-etudes'},
      name: 'Alice', email: email.value,
    });
  });

  it('requires a valid new password in password mode and omits email delivery controls', async () => {
    const {fetch, onClaimed, workspace, admin, email, form} = setup(true);
    workspace.value = 'Studio';
    admin.value = 'Alice';
    email.value = 'alice@example.test';
    const password = must(form.querySelector<HTMLInputElement>('input[type=password]'));
    expect(password.autocomplete).toBe('new-password');
    expect(document.querySelector('details')).toBeNull();
    expect(document.body.textContent).not.toContain('code de connexion');

    for (const value of ['🐈'.repeat(8), 'é'.repeat(513)]) {
      password.value = value;
      password.dispatchEvent(new Event('input'));
      form.requestSubmit();
      expect(password.validity.valid).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();

    password.value = '🐈'.repeat(12);
    password.dispatchEvent(new Event('input'));
    form.requestSubmit();
    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledWith(email.value, password.value));
    expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1]))).toMatchObject({password: password.value});
  });

  it('requires a nonblank workspace name within the server limit', () => {
    const {fetch, workspace, admin, email, form} = setup();
    email.value = 'alice@example.test';
    admin.value = 'Alice';
    for (const value of ['', '  ', 'é'.repeat(61)]) {
      workspace.value = value;
      workspace.dispatchEvent(new Event('input'));
      form.requestSubmit();
      expect(workspace.validity.valid).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets an administrator check mail delivery before claiming the workspace', async () => {
    const {fetch, email, onClaimed} = setup();
    const details = must(document.querySelector('details'));
    expect(details.open).toBe(false);
    details.open = true;
    email.value = 'alice@example.test';
    must(details.querySelector('button')).click();
    await vi.waitFor(() => expect(details.querySelector('[role=status]')?.textContent).toContain(email.value));
    expect(fetch.mock.calls[0]?.[0]).toMatch(/\/api\/setup\/email-test$/);
    expect(onClaimed).not.toHaveBeenCalled();
  });
});
