import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('sendWorkspaceInviteEmail', () => {
  const envKeys = ['MAILER_HOST', 'SMTP_HOST', 'AUTH_LOG_CODE', 'PUBLIC_URL'] as const;

  const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('no-ops with sent:false when mailer host is unset', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sendWorkspaceInviteEmail } = await import('./smtp.ts');

    const result = await sendWorkspaceInviteEmail('invitee@example.com', 'invite-id', 'ws-id');

    expect(result).toEqual({ sent: false });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs invite metadata when AUTH_LOG_CODE=1 and host is unset', async () => {
    process.env.AUTH_LOG_CODE = '1';
    process.env.PUBLIC_URL = 'https://app.example';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sendWorkspaceInviteEmail } = await import('./smtp.ts');

    await sendWorkspaceInviteEmail('invitee@example.com', 'invite-id', 'ws-id');

    expect(log).toHaveBeenCalledWith(
      '[mail] workspace invite for invitee@example.com: invite=invite-id workspace=ws-id link=https://app.example (mailer not configured)',
    );
  });
});

describe('sendAuthCode', () => {
  const envKeys = [
    'MAILER_HOST',
    'SMTP_HOST',
    'AUTH_LOG_CODE',
  ] as const;

  const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('no-ops with sent:false when mailer host is unset', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sendAuthCode } = await import('./smtp.ts');

    const result = await sendAuthCode('user@example.com', '123456');

    expect(result).toEqual({ sent: false });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs the code when AUTH_LOG_CODE=1 and host is unset', async () => {
    process.env.AUTH_LOG_CODE = '1';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sendAuthCode } = await import('./smtp.ts');

    await sendAuthCode('user@example.com', '654321');

    expect(log).toHaveBeenCalledWith(
      '[mail] auth code for user@example.com: 654321 (mailer not configured)',
    );
  });
});