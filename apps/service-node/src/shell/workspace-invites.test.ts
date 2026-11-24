import { describe, expect, it, vi, afterEach } from 'vitest';
import { createInviteMail } from './invite-mail.js';
import { parseInvite } from './workspace-invites.js';

describe('workspace invite fields', () => {
  it('keeps the delivery note and accepts the Go default role', () => {
    expect(parseInvite({ email: 'X@site', role: '', message: '🍋'.repeat(2000) })).toEqual({
      email: 'X@site', role: 'member', message: '🍋'.repeat(2000),
    });
    expect(parseInvite({email:'x@site'})).toEqual({email:'x@site',role:'member',message:''});
  });
  it.each([null, [], {}, {email:'x',role:'admin'}, {email:'x',role:0}, {email:'x',message:[]}, {email:'x',message:'🍋'.repeat(2001)}])(
    'rejects invalid invitation fields', input => expect(() => parseInvite(input)).toThrow());
});

describe('workspace invite email bridge', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends only the stored invitation identifier and the optional text to the fixed mail transport', async () => {
    const transport = vi.fn().mockResolvedValueOnce(Response.json({email:'a@example.test'})).mockResolvedValueOnce(new Response(null,{status:204}));
    vi.stubGlobal('fetch', transport);
    const mail = createInviteMail('internal');
    expect(await mail.normalize(' A@EXAMPLE.TEST ')).toBe('a@example.test');
    await mail.deliver('id/1','note');
    expect(transport.mock.calls.map(call => call[0])).toEqual([
      'http://127.0.0.1:8080/internal/invitations/normalize', 'http://127.0.0.1:8080/internal/invitations/id%2F1/mail',
    ]);
    expect(transport.mock.calls[1]?.[1]).toMatchObject({ redirect:'error', headers:{ Authorization:'Bearer internal' }, body:'{"message":"note"}' });
  });
});
