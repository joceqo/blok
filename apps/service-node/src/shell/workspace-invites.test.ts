import { describe, expect, it, vi } from 'vitest';
import { createInviteMail } from './invite-mail.ts';
import { parseInvite } from './workspace-invites.ts';

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

describe('workspace invitation delivery', () => {
  it('delivers the stored invitation to its intended recipient', async () => {
    const query = vi.fn().mockResolvedValue({rows:[{email:'a@example.test',name:'Équipe'}]});
    const send = vi.fn();
    const mail = createInviteMail({query},send);
    expect(await mail.normalize(' A@EXAMPLE.TEST ')).toBe('a@example.test');
    await mail.deliver('id/1','note');
    expect(query.mock.calls[0]?.[1]).toEqual(['id/1']);
    expect(send).toHaveBeenCalledWith('a@example.test','Invitation Blok — Équipe',expect.stringContaining('note'),expect.stringContaining('note'));
    query.mockResolvedValue({rows:[]});
    await expect(mail.deliver('revoked','note')).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
