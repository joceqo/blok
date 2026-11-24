import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { hashSecret, normalizeEmail } from '../auth/codes.ts';

const timeout = 20_000;
const controls = /\p{Cc}/u;
const atom = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+$/u;

export function validateAddress(raw: string): string | undefined {
  const address = normalizeEmail(raw);
  const parts = address.split('@');
  if (parts.length !== 2 || Buffer.byteLength(address) > 254 || controls.test(address)) return;
  if (!parts[0]!.split('.').every((part) => atom.test(part))) return;
  const domain = parts[1]!;
  if (
    !domain.split('.').every((part) => atom.test(part)) &&
    !(domain.startsWith('[') && domain.endsWith(']') && isIP(domain.slice(1, -1)))
  )
    return;
  return address;
}

function smtpSetting(primary: string, legacy: string, fallback = '') {
  return process.env['MAILER_' + primary] ?? process.env['SMTP_' + legacy] ?? fallback;
}

export function mailBackend() {
  if (process.env.APP_ENV === 'development' && process.env.DEV_MAIL_DIRECTORY) return 'development';
  if (smtpSetting('HOST', 'HOST')) return 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  return '';
}

export function passwordAuthAvailable() {
  const backend = mailBackend();
  return backend === '' || backend === 'development';
}

async function sendSMTP(to: string, subject: string, text: string) {
  const host = smtpSetting('HOST', 'HOST');
  const port = Number(smtpSetting('PORT', 'PORT', '587'));
  const user = smtpSetting('USER', 'USERNAME');
  const pass = smtpSetting('PASSWORD', 'PASSWORD');
  const insecure = smtpSetting('ALLOW_INSECURE_DEVELOPMENT', 'ALLOW_INSECURE_DEVELOPMENT') === 'true';
  if (
    (!isIP(host) && !/^[a-z0-9][a-z0-9._-]*$/i.test(host)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !!user !== !!pass ||
    controls.test(user + pass) ||
    (insecure && process.env.APP_ENV !== 'development')
  ) {
    throw new Error('Invalid SMTP configuration');
  }
  const raw = smtpSetting('FROM_EMAIL', 'FROM');
  const displayName = smtpSetting('FROM_NAME', 'FROM_NAME');
  const senders = addressparser(raw, { flatten: true });
  const sender = senders[0];
  if (
    controls.test(raw + displayName) ||
    senders.length !== 1 ||
    !sender ||
    !validateAddress(sender.address)
  ) {
    throw new Error('Invalid SMTP sender');
  }
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: !insecure && port !== 465,
    tls: { minVersion: 'TLSv1.2' },
    auth: user ? { user, pass } : undefined,
    connectionTimeout: timeout,
    socketTimeout: timeout,
    greetingTimeout: timeout,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({
      from: { name: displayName || sender.name, address: sender.address },
      to,
      subject,
      text,
    });
  } finally {
    transport.close();
  }
}

export async function sendMail(to: string, subject: string, text: string) {
  const address = validateAddress(to);
  if (!address || controls.test(to) || controls.test(subject)) throw new Error('Invalid mail headers');
  switch (mailBackend()) {
    case 'development': {
      const directory = process.env.DEV_MAIL_DIRECTORY!;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, hashSecret(address) + '.json');
      const tmp = join(directory, '.' + randomUUID() + '.tmp');
      try {
        await writeFile(tmp, JSON.stringify({ to: address, subject, text }), { flag: 'wx', mode: 0o600 });
        await rename(tmp, file);
      } finally {
        await rm(tmp, { force: true });
      }
      return;
    }
    case 'smtp':
      return sendSMTP(address, subject, text);
    case 'resend': {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
        headers: {
          Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: process.env.MAIL_FROM, to: [address], subject, text }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Resend delivery failed');
      return;
    }
    default:
      throw new Error('Mail delivery not configured');
  }
}
