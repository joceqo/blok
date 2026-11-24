import { afterEach, expect, it, vi } from 'vitest';
import { openPageHistory } from './page-history';

afterEach(() => {
  document.querySelector<HTMLButtonElement>('[data-navigation-close]')?.click();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'shows a read-only version preview and enforces the current restore capability (%s)',
  async (editable) => {
    const base = 'http://localhost/api/blok/sync/doc/history';
    const calls: string[] = [];
    const request = vi.fn(async (url: string, init: RequestInit) => {
      const path = url.slice(base.length);
      calls.push(path);
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fresh');
      if (!path)
        return Response.json({
          versions: [
            { lineage: 'a', sequence: 1, savedAt: 1 },
            { lineage: 'a', sequence: 0, savedAt: null },
          ],
        });
      if (path.endsWith('preview')) return Response.json({ expectRevision: 'a:1', fits: true, guards: [] });
      if (path.endsWith('restore')) {
        const headers = new Headers(init.headers);
        expect(headers.get('if-match')).toBe('"a:1"');
        expect(headers.get('blok-idempotency-key')).toBeTruthy();
        return new Response(null, { status: 204 });
      }
      return Response.json({
        blocks: [{ id: 'a', type: 'paragraph', data: { text: path.endsWith('0') ? 'Ancien' : 'Actuel' } }],
      });
    });
    vi.stubGlobal('fetch', request);
    openPageHistory({
      base,
      title: 'Plan',
      ticket: async () => 'fresh',
      editable: () => editable,
      flush: async () => {},
    });
    const select = document.querySelector('select')!;
    const preview = document.querySelector('[data-history-preview]')!;
    await vi.waitFor(() => expect(preview.textContent).toContain('Actuel'));
    select.selectedIndex = 1;
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(preview.textContent).toContain('Ancien'));
    const button = document.querySelector<HTMLButtonElement>('[data-history-actions] button');
    if (editable) {
      expect(button).not.toBeNull();
      button!.click();
      await vi.waitFor(() => expect(document.querySelector('[data-desktop-history]')).toBeNull());
      expect(calls).toContain('/a/0/restore');
    } else {
      expect(button).toBeNull();
      expect(calls).not.toContain('/a/0/restore/preview');
    }
  },
);
