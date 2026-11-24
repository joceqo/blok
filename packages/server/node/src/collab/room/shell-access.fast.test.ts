import { afterEach, expect, it, vi } from 'vitest';
import { shellRoomTickets } from './shell-access.ts';

const origin = 'http://127.0.0.1:8080';
const secret = 's'.repeat(32);
const session = 'a'.repeat(64);
afterEach(() => vi.unstubAllGlobals());

it('submits a ticket once per connection, then rechecks its bound session and document', async () => {
  const http = vi.fn()
    .mockResolvedValueOnce(Response.json({read:true,write:false,session,ticketWrite:false}))
    .mockResolvedValueOnce(Response.json({read:true,write:true}))
    .mockResolvedValueOnce(Response.json({read:false,write:false}));
  vi.stubGlobal('fetch',http);
  const admit = shellRoomTickets(origin,secret);
  const alice = await admit('ticket-1','doc-1');
  expect(alice).toMatchObject({id:session,write:false});
  expect(await alice!.revalidate!()).toEqual({id:session,write:false});
  expect(await alice!.revalidate!()).toBeNull();
  const requests = http.mock.calls.map(([url, request]) => {
    expect(url.href).toBe(origin + '/internal/room-access');
    expect(request.redirect).toBe('error');
    expect(request.headers.Authorization).toBe('Bearer '+secret);
    return JSON.parse(request.body);
  });
  expect(requests).toEqual([{ticket:'ticket-1',documentId:'doc-1'},{session,documentId:'doc-1'},{session,documentId:'doc-1'}]);
});

it('requires an authenticated admission response with a valid session, role ceiling and read permission', async () => {
  const http = vi.fn();
  vi.stubGlobal('fetch',http);
  const admit = shellRoomTickets(origin,secret);
  for (const body of [
    { read:true,write:true }, { read:false,write:true,session,ticketWrite:true }, {read:true,write:true,session,ticketWrite:'false'},
  ]) {
    http.mockResolvedValueOnce(Response.json(body));
    expect(await admit('signed','doc')).toBeNull();
  }
  http.mockResolvedValueOnce(new Response(null,{status:503}));
  expect(await admit('signed','doc')).toBeNull();
  expect(() => shellRoomTickets('http://user:pass@host',secret)).toThrow();
});

it('requires the selected workspace during both admission and revocation checks', async () => {
  const http = vi.fn();
  vi.stubGlobal('fetch', http);
  const admit = shellRoomTickets(origin, secret, 'selected');
  const response = {read:true, write:true, session, ticketWrite:true};
  for (const workspaceId of [undefined,'other']) {
    http.mockResolvedValueOnce(Response.json({...response,workspaceId}));
    expect(await admit('ticket','page')).toBeNull();
  }
  http.mockResolvedValueOnce(Response.json({...response,workspaceId:'selected'}));
  const grant = await admit('ticket','page');
  expect(grant?.workspaceId).toBe('selected');
  http.mockResolvedValueOnce(Response.json({read:true,write:true,workspaceId:'other'}));
  expect(await grant?.revalidate?.()).toBeNull();
});
