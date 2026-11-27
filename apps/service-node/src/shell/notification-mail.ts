import { mailTemplate } from './mail-template.ts';
import { sendMail } from './mail.ts';

export interface Notice {
  recipient_id: string;
  type: string;
  page_id?: string | null;
}

/** What each notification says in its mail, by type. */
const wording: Record<string, { headline: string; detail: string }> = {
  comment_mention: { headline: 'Vous avez été mentionné', detail: 'Quelqu’un vous a mentionné dans un commentaire.' },
  comment_reply: { headline: 'Réponse à votre commentaire', detail: 'Quelqu’un a répondu à votre commentaire.' },
  join_requested: { headline: 'Demande d’accès', detail: 'Quelqu’un demande à rejoindre cet espace de travail.' },
  join_approved: { headline: 'Demande acceptée', detail: 'Votre demande à rejoindre cet espace a été acceptée.' },
  join_rejected: { headline: 'Demande refusée', detail: 'Votre demande à rejoindre cet espace a été refusée.' },
  calendar_invitation: { headline: 'Invitation à un événement', detail: 'Vous avez été invité à un événement du calendrier.' },
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
  const { rows } = await pool.query(
    `SELECT p.user_id, u.email, w.name AS workspace FROM email_notification_preferences p
     JOIN users u ON u.id=p.user_id
     JOIN workspaces w ON w.id=p.workspace_id
     WHERE p.workspace_id=$1 AND p.activity AND p.user_id = ANY($2::text[])`,
    [workspaceId, notices.map((notice) => notice.recipient_id)],
  );
  const wanted = new Map(rows.map((row) => [row.user_id, row]));
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
