import { createInternalMailTransport } from './internal-mail.ts';
import { WorkspaceError } from './workspace-scope.ts';

export interface InviteMail {
  normalize(email: string): Promise<string>;
  deliver(inviteId: string, message: string): Promise<void>;
}

// Keep SMTP/Resend credentials, address parsing and the configured public URL
// in the same process as the authentication email transport.
export function createInviteMail(secret: string): InviteMail {
  const post = createInternalMailTransport(secret);
  return {
    async normalize(email) {
      const response = await post('/internal/invitations/normalize', { email });
      if (response.status === 400) throw new WorkspaceError(400, 'Invalid email');
      if (!response.ok) throw new Error('Invitation address validation unavailable');
      const data = await response.json() as { email?: string };
      if (!data.email) throw new Error('Invitation address validation unavailable');
      return data.email;
    },
    async deliver(inviteId, message) {
      const response = await post('/internal/invitations/' + encodeURIComponent(inviteId) + '/mail', { message });
      if (response.status !== 204) throw new Error('Invitation email delivery failed');
    },
  };
}
