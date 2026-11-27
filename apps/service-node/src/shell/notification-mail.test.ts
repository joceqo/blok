import { describe, expect, it, vi } from 'vitest';
import { deliverNotificationMails } from './notification-mail.ts';

/** A pool stub whose query returns the preference rows the test sets up. */
function db(rows: { user_id: string; email: string; workspace: string }[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

const notices = [{ recipient_id: 'u1', type: 'comment_mention', page_id: 'p1' }];

describe('notification e-mails', () => {
  it('sends nothing when no preference row says yes', async () => {
    // Absent or false is the default: the query only returns members who
    // asked, so an empty result must stay silent.
    const send = vi.fn();
    const pool = db([]);
    await deliverNotificationMails(pool, 'acme', notices, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one mail per recipient who asked for it', async () => {
    const send = vi.fn();
    const pool = db([{ user_id: 'u1', email: 'u1@example.test', workspace: 'Acme' }]);
    await deliverNotificationMails(pool, 'acme', notices, send);
    expect(send).toHaveBeenCalledTimes(1);
    const [to, subject, text, html] = send.mock.calls[0]!;
    expect(to).toBe('u1@example.test');
    expect(subject).toContain('Acme');
    expect(text).toBeTruthy();
    expect(html).toContain('<');
  });

  it('asks the database only for members who turned the setting on', async () => {
    const pool = db([]);
    await deliverNotificationMails(pool, 'acme', notices, vi.fn());
    const [sql] = pool.query.mock.calls[0]!;
    expect(sql).toContain('activity');
  });

  it('keeps one failed delivery from stopping the others', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('smtp down'))
      .mockResolvedValueOnce(undefined);
    const pool = db([
      { user_id: 'u1', email: 'u1@example.test', workspace: 'Acme' },
      { user_id: 'u2', email: 'u2@example.test', workspace: 'Acme' },
    ]);
    const both = [...notices, { recipient_id: 'u2', type: 'comment_reply', page_id: 'p1' }];
    await expect(deliverNotificationMails(pool, 'acme', both, send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
