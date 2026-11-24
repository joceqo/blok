import { loadConfig } from '../config.ts';

export type SendMailResult = { sent: boolean };

export type SendAuthCodeResult = SendMailResult;

/**
 * Delivers login codes. When `mailerHost` is set, a nodemailer transport will
 * live here; until then the call is a structured no-op.
 */
export async function sendAuthCode(
  email: string,
  code: string,
): Promise<SendAuthCodeResult> {
  const { mailerHost } = loadConfig();
  const hostConfigured = mailerHost !== undefined && mailerHost !== '';

  if (process.env.AUTH_LOG_CODE === '1') {
    const note = hostConfigured ? '(SMTP send not wired yet)' : '(mailer not configured)';
    console.error(`[mail] auth code for ${email}: ${code} ${note}`);
  }

  if (!hostConfigured) {
    return { sent: false };
  }

  // Future: createTransport from nodemailer using mailerHost + SMTP_* env vars.
  return { sent: false };
}

export type SendWorkspaceInviteEmailResult = SendMailResult;

/**
 * Delivers workspace invite links. Same no-op contract as {@link sendAuthCode}
 * until nodemailer is wired.
 */
export async function sendWorkspaceInviteEmail(
  email: string,
  inviteId: string,
  workspaceId: string,
): Promise<SendWorkspaceInviteEmailResult> {
  const { mailerHost, publicUrl } = loadConfig();
  const hostConfigured = mailerHost !== undefined && mailerHost !== '';

  if (process.env.AUTH_LOG_CODE === '1') {
    const linkBase = publicUrl ?? '(PUBLIC_URL unset)';
    const note = hostConfigured ? '(SMTP send not wired yet)' : '(mailer not configured)';
    console.error(
      `[mail] workspace invite for ${email}: invite=${inviteId} workspace=${workspaceId} link=${linkBase} ${note}`,
    );
  }

  if (!hostConfigured) {
    return { sent: false };
  }

  return { sent: false };
}