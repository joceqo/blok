import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  take:vi.fn(), session:vi.fn(), flush:vi.fn(), select:vi.fn(),
}));
vi.mock('./native-runtime',()=>({ nativeBridge:()=>({invoke:mocks.take}), deviceWorkspaces:mocks.session }));
vi.mock('./workspace-registry',()=>({ activeWorkspace:()=>({kind:'local',id:'default'}), selectWorkspace:mocks.select }));
vi.mock('./shell',()=>({flushDesktop:mocks.flush}));

import { listenForPageLinks } from './native-page-links';

afterEach(() => vi.unstubAllGlobals());
it('checks device membership before handing off a cold or warm page link and flushes edits before opening it', async () => {
  const ref = {id:'workspace-1',workspaceId:'mine'};
  const origin='http://127.0.0.1:1234';
  mocks.session.mockResolvedValue({origin,result:{token:'local-session'},references:[ref]});
  mocks.take.mockResolvedValueOnce('blok://page/p1?origin=http%3A%2F%2F127.0.0.1%3A5678');
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({pages:[{id:'p1'}]})));
  vi.stubGlobal('fetch',fetch);
  const report=vi.fn();
  listenForPageLinks(report);
  await vi.waitFor(()=>expect(report).toHaveBeenCalledTimes(1));
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();

  mocks.take.mockResolvedValueOnce('blok://page/p1?device=1&workspace=workspace-1');
  window.dispatchEvent(new Event('blok:page-link'));
  await vi.waitFor(()=>expect(mocks.select).toHaveBeenCalledWith(ref,'p1'));
  expect(fetch).toHaveBeenCalledWith(origin+'/api/workspaces/mine/index',expect.objectContaining({redirect:'error',headers:{Authorization:'Bearer local-session'}}));
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]);

  mocks.take.mockResolvedValueOnce('blok://page/missing?device=1');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({pages:[]})));
  window.dispatchEvent(new Event('blok:page-link'));
  await vi.waitFor(()=>expect(report).toHaveBeenCalledTimes(2));
  expect(mocks.select).toHaveBeenCalledTimes(1);
});
