import {afterEach, expect, it, vi} from 'vitest';
import {workspaceRepository} from './workspace-repository';

afterEach(() => vi.unstubAllGlobals());

it('requests a scoped ticket and the live body only when duplication asks for it', async () => {
  const body = {blocks: [{id: 'p', type: 'paragraph', data: {text: [{text: 'Latest edit'}]}}]};
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes('/ticket?') ? {ticket: 'body-ticket'} : body));
  vi.stubGlobal('fetch', fetcher);
  const repository = workspaceRepository({kind: 'remote', id: 'remote', name: 'Team', server: 'https://example.test', workspaceId: 'team', accountId: 'account'});
  expect(fetcher).not.toHaveBeenCalled();
  expect(await repository.readLivePage('body')).toEqual(body);
  expect(fetcher).toHaveBeenNthCalledWith(1, 'https://example.test/api/workspaces/team/ticket?doc=body', expect.any(Object));
  expect(fetcher).toHaveBeenNthCalledWith(2, 'https://example.test/api/blok/sync/body/state', expect.objectContaining({headers: expect.objectContaining({Authorization: 'Bearer body-ticket'})}));
});

it('does not read a body when the ticket is refused', async () => {
  const fetcher = vi.fn(async () => new Response('{}', {status: 404}));
  vi.stubGlobal('fetch', fetcher);
  const repository = workspaceRepository({kind: 'remote', id: 'remote', name: 'Team', server: 'https://example.test', workspaceId: 'team', accountId: 'account'});
  await expect(repository.readLivePage('private')).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
