import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../auth/codes.ts';
import { mailBackend, sendMail, validateAddress } from './mail.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('native mail transports', () => {
  it.each(['bad', 'a..b@example.test', 'p@a@b', 'name <a@site>', 'a@x\r\nBcc: b@evil'])(
    'rejects invalid recipient %s',
    (value) => expect(validateAddress(value)).toBeUndefined(),
  );
  it('atomically delivers development messages in the existing mailbox format', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blok-mail-'));
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('DEV_MAIL_DIRECTORY', directory);
    vi.stubEnv('RESEND_API_KEY', 'unused');
    try {
      expect(mailBackend()).toBe('development');
      await sendMail(' Élodie@example.test ', 'Connexion', 'Code 123456');
      const file = join(directory, hashSecret('élodie@example.test') + '.json');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        to: 'élodie@example.test',
        subject: 'Connexion',
        text: 'Code 123456',
      });
      await expect(sendMail('a@test', 'Header\r\nX: injected', '')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('sends Resend requests with bounded time and rejects provider failure', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('MAILER_HOST', '');
    vi.stubEnv('RESEND_API_KEY', 'test');
    vi.stubEnv('MAIL_FROM', 'test@example.test');
    const transport = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', transport);
    await expect(sendMail('a@test', 'Subject', 'body')).rejects.toThrow('Resend');
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      body: JSON.stringify({ from: 'test@example.test', to: ['a@test'], subject: 'Subject', text: 'body' }),
    });
  });
  it('requires production STARTTLS and delivers through a local development SMTP relay', async () => {
    const messages: string[] = [];
    const smtp = createServer((socket) => {
      socket.write('220 localhost SMTP\r\n');
      let buffer = '',
        contents: string[] | undefined;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        for (let pos; (pos = buffer.indexOf('\r\n')) !== -1; ) {
          const line = buffer.slice(0, pos);
          buffer = buffer.slice(pos + 2);
          if (contents) {
            if (line !== '.') {
              contents.push(line);
              continue;
            }
            messages.push(contents.join('\n'));
            contents = undefined;
          } else if (line.startsWith('EHLO ')) {
            socket.write('250-localhost\r\n250 8BITMIME\r\n');
            continue;
          } else if (line === 'DATA') {
            contents = [];
            socket.write('354 End with dot\r\n');
            continue;
          } else if (line === 'QUIT') {
            socket.end('221 Bye\r\n');
            continue;
          } else if (line === 'STARTTLS') {
            socket.write('502 STARTTLS unavailable\r\n');
            continue;
          }
          socket.write('250 OK\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    try {
      const addr = smtp.address();
      vi.stubEnv('MAILER_HOST', '127.0.0.1');
      vi.stubEnv('MAILER_PORT', String(typeof addr === 'object' && addr?.port));
      vi.stubEnv('MAILER_FROM_EMAIL', 'Blok <noreply@example.test>');
      vi.stubEnv('DEV_MAIL_DIRECTORY', '');
      vi.stubEnv('APP_ENV', 'production');
      await expect(sendMail('me@example.test', 'test', 'CODE')).rejects.toThrow();
      expect(messages).toEqual([]);
      vi.stubEnv('APP_ENV', 'development');
      vi.stubEnv('MAILER_ALLOW_INSECURE_DEVELOPMENT', 'true');
      await sendMail('me@example.test', 'test', 'CODE');
      expect(messages[0]).toContain('CODE');
    } finally {
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
    }
  });
});
