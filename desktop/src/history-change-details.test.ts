import { afterEach, expect, it, vi } from 'vitest';
import { historyChangeDetails } from './history-change-details';

afterEach(() => document.body.replaceChildren());
it('shows explicit property differences and acting identity and loads older edits on demand', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      changes: [
        {
          sequence: 3,
          actors: [{ id: 'assistant', kind: 'agent', onBehalfOf: 'Alice' }],
          blocks: [
            {
              id: 'ligne',
              properties: [
                { id: 'prix', after: 0 },
                { id: 'vide', before: null },
                { id: 'titre', after: '<script>' },
              ],
              schema: [{ id: 'prop', name: 'Budget', action: 'created' }],
              views: [{ id: 'vue', action: 'updated' }],
            },
          ],
        },
      ],
      truncated: true,
      olderEnd: { lineage: 'a', sequence: 3 },
    })
    .mockResolvedValueOnce({ changes: [{ sequence: 2, actor: 'Alice', blocks: [] }], truncated: false });
  const element = historyChangeDetails(request, 'a', 3, 1);
  document.body.append(element);
  expect(request).not.toHaveBeenCalled();
  element.open = true;
  element.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(element.textContent).toContain('Agent assistant pour Alice'));
  expect(element.textContent).toContain('prix : absent → 0');
  expect(element.textContent).toContain('vide : null → absent');
  expect(element.textContent).toContain('Propriété Budget · création');
  expect(element.textContent).toContain('Vue vue · modification');
  expect(element.querySelector('script')).toBeNull();
  element.querySelector('button')!.click();
  await vi.waitFor(() => expect(element.textContent).toContain('Modification 2'));
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    '/a/3/changes?since=1&detail=properties',
    '/a/2/changes?since=1&detail=properties',
  ]);
  expect(element.querySelector('button')?.hidden).toBe(true);
});
