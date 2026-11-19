import { loadConfig } from '../config.js';

export type SendAuthCodeResult = { sent: boolean };

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