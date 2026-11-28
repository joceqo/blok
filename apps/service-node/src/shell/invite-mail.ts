import type { PgPool } from '../db/pool.ts';
import { mailTemplate } from './mail-template.ts';
import { sendMail, validateAddress } from './mail.ts';
import { WorkspaceError } from './workspace-scope.ts';

export interface InviteMail {
  normalize(email: string): Promise<string>;
  deliver(inviteId: string, message: string): Promise<void>;
}

export function createInviteMail(pool: Pick<PgPool, 'query'>, send = sendMail): InviteMail {
  return {
    async normalize(email) {
      const address = validateAddress(email);
      if (!address) throw new WorkspaceError(400, 'Invalid email');
      return address;
    },
    async deliver(inviteId, message) {
      const {
        rows: [invite],
      } = await pool.query<{ email: string; name: string }>(
        `SELECT i.email,w.name FROM invites i JOIN workspaces w ON w.id=i.workspace_id
         WHERE i.id=$1 AND i.status='delivering' AND i.expires_at>now()`,
        [inviteId],
      );
      if (!invite) throw new Error('Deliverable invitation not found');
      const { text, html } = await mailTemplate('invitation', {
        workspace: invite.name,
        publicURL: process.env.PUBLIC_URL ?? '',
        message: message ?? '',
      });
      await send(invite.email, 'Invitation Blok — ' + invite.name, text, html);
    },
  };
}
