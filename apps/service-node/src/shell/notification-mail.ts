import { mailTemplate } from './mail-template.ts';
import { sendMail } from './mail.ts';

export interface Notice {
  recipient_id: string;
  type: string;
  page_id?: string | null;
}

/**
 * The preference column each type answers to. Someone who wants to hear
 * about event invitations should not have to accept every comment mention.
 */
const governedBy: Record<string, string> = {
  comment_mention: 'activity',
  comment_reply: 'activity',
  join_requested: 'activity',
  join_approved: 'activity',
  join_rejected: 'activity',
  calendar_invitation: 'calendar_invites',
  calendar_response: 'calendar_responses',
};

/** What each notification says in its mail, by type. */
const wording: Record<string, { headline: string; detail: string }> = {
  comment_mention: { headline: 'Vous avez été mentionné', detail: 'Quelqu’un vous a mentionné dans un commentaire.' },
  comment_reply: { headline: 'Réponse à votre commentaire', detail: 'Quelqu’un a répondu à votre commentaire.' },
  join_requested: { headline: 'Demande d’accès', detail: 'Quelqu’un demande à rejoindre cet espace de travail.' },
  join_approved: { headline: 'Demande acceptée', detail: 'Votre demande à rejoindre cet espace a été acceptée.' },
  join_rejected: { headline: 'Demande refusée', detail: 'Votre demande à rejoindre cet espace a été refusée.' },
  calendar_invitation: { headline: 'Invitation à un événement', detail: 'Vous avez été invité à un événement du calendrier.' },
  calendar_response: { headline: 'Réponse à votre invitation', detail: 'Un invité a répondu à votre événement.' },
};

/**
 * Mails the people among `notices` who turned e-mail notifications on for
 * this workspace. Absence of a preference row means no: the query returns
 * only members who asked, so a quiet workspace stays quiet.
 *
 * One failed delivery never costs the others theirs, and never the caller's
 * transaction: a mail that cannot leave is not a reason to lose the
 * notification that is already recorded.
 */
export async function deliverNotificationMails(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { user_id: string; email: string; workspace: string }[] }> },
  workspaceId: string,
  notices: Notice[],
  send = sendMail,
): Promise<void> {
  if (notices.length === 0) return;
  // One query per preference column, each asking only for the members that
  // column governs.
  const byColumn = new Map<string, Notice[]>();
  for (const notice of notices) {
    const column = governedBy[notice.type];
    if (!column) continue;
    byColumn.set(column, [...(byColumn.get(column) ?? []), notice]);
  }
  if (byColumn.size === 0) return;
  const wanted = new Map<string, { user_id: string; email: string; workspace: string }>();
  for (const [column, governed] of byColumn) {
    const { rows } = await pool.query(
      `SELECT p.user_id, u.email, w.name AS workspace FROM email_notification_preferences p
       JOIN users u ON u.id=p.user_id
       JOIN workspaces w ON w.id=p.workspace_id
       WHERE p.workspace_id=$1 AND p.${column} AND p.user_id = ANY($2::text[])`,
      [workspaceId, governed.map((notice) => notice.recipient_id)],
    );
    for (const row of rows) wanted.set(row.user_id, row);
  }
  const link = process.env.PUBLIC_URL ?? '';
  await Promise.all(
    notices.map(async (notice) => {
      const member = wanted.get(notice.recipient_id);
      if (!member) return;
      const words = wording[notice.type];
      if (!words) return;
      try {
        const { text, html } = await mailTemplate('notification', {
          workspace: member.workspace,
          headline: words.headline,
          detail: words.detail,
          link,
        });
        await send(member.email, `${words.headline} — ${member.workspace}`, text, html);
      } catch {
        // The notification is recorded; a mail that cannot leave is not a
        // reason to fail the others or the caller.
      }
    }),
  );
}
