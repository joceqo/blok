import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellApp } from './app.ts';
import { deliverNotificationMails } from './notification-mail.ts';

const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
const schemaPath = process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url);

/**
 * Le commutateur d'espace, éprouvé sur le schéma réellement déployé : la
 * colonne, sa valeur par défaut, la route qui l'écrit et la requête d'envoi
 * qui la lit. Un double de pool dirait oui à tout, y compris à une colonne
 * qui n'existe pas.
 */
describe.skipIf(!databaseUrl)('le commutateur d’e-mails de l’espace', () => {
  const schema = 'test_mail_switch_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const db = new pg.Pool({ connectionString: databaseUrl, options: '-csearch_path=' + schema });
  const app = createShellApp(db, 's'.repeat(32), new Set());

  const call = (user: string, method = 'GET', input?: Record<string, unknown>) =>
    app.request('/api/workspaces/alpha', {
      method,
      headers: { Authorization: 'Bearer ' + user },
      body: input && JSON.stringify(input),
    });

  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(schemaPath, 'utf8'));
    await db.query(`INSERT INTO users(id,email) VALUES('boss','boss@site.test'),('hand','hand@site.test');
      INSERT INTO workspaces(id,slug,name) VALUES('w','alpha','Alpha');
      INSERT INTO memberships VALUES('w','boss','admin'),('w','hand','member');
      INSERT INTO email_notification_preferences(workspace_id,user_id,activity) VALUES('w','hand',true)`);
    for (const user of ['boss', 'hand']) {
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
        [createHash('sha256').update(user).digest('hex'), user]);
    }
  });
  beforeEach(() => db.query('UPDATE workspaces SET allow_notification_mail=true, icon=$2, name=$1', ['Alpha', '']));
  afterAll(async () => {
    await db.end();
    try { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); } finally { await admin.end(); }
  });

  it('ouvre les e-mails par défaut, pour ne rien couper à un espace qui existait déjà', async () => {
    expect(await (await call('hand')).json()).toMatchObject({ allowNotificationMail: true });
  });

  it('laisse un administrateur les couper, et le dit à tout le monde', async () => {
    expect((await call('boss', 'PATCH', { allowNotificationMail: false })).status).toBe(200);
    expect(await (await call('hand')).json()).toMatchObject({ allowNotificationMail: false });
  });

  it('refuse le commutateur à un membre, sans rien écrire', async () => {
    expect((await call('hand', 'PATCH', { allowNotificationMail: false })).status).toBe(403);
    expect(await (await call('hand')).json()).toMatchObject({ allowNotificationMail: true });
  });

  it('renomme toujours sans toucher au commutateur, et l’inverse', async () => {
    expect((await call('boss', 'PATCH', { name: 'Oméga' })).status).toBe(200);
    expect(await (await call('boss')).json()).toMatchObject({ name: 'Oméga', allowNotificationMail: true });
    expect((await call('boss', 'PATCH', { allowNotificationMail: false })).status).toBe(200);
    expect(await (await call('boss')).json()).toMatchObject({ name: 'Oméga', allowNotificationMail: false });
  });

  it('refuse un corps qui ne demande rien, plutôt que d’écrire au hasard', async () => {
    expect((await call('boss', 'PATCH', {})).status).toBe(400);
    expect((await call('boss', 'PATCH', { name: '   ' })).status).toBe(400);
    expect((await call('boss', 'PATCH', { allowNotificationMail: 'oui' })).status).toBe(400);
  });

  it('garde l’espace sans icône tant que personne n’en pose une', async () => {
    expect(await (await call('hand')).json()).toMatchObject({ icon: '' });
  });

  it('accepte un émoji, une icône nommée et un PNG, et refuse le reste', async () => {
    expect((await call('boss', 'PATCH', { icon: '🌱' })).status).toBe(200);
    expect(await (await call('hand')).json()).toMatchObject({ icon: '🌱' });
    expect((await call('boss', 'PATCH', { icon: 'icon:leaf:green' })).status).toBe(200);
    // Les bornes sont celles des espaces d'équipe : un seul grapheme, un PNG
    // de 96 px au plus. Une URL distante ferait sortir une requête du client.
    expect((await call('boss', 'PATCH', { icon: 'https://ailleurs.test/logo.png' })).status).toBe(400);
    expect((await call('boss', 'PATCH', { icon: 'deux 🌱🌿' })).status).toBe(400);
    expect((await call('boss', 'PATCH', { icon: 42 })).status).toBe(400);
    expect(await (await call('hand')).json()).toMatchObject({ icon: 'icon:leaf:green' });
  });

  it('refuse l’icône à un membre, et la garde à travers un renommage', async () => {
    await call('boss', 'PATCH', { icon: '🌱' });
    expect((await call('hand', 'PATCH', { icon: '💀' })).status).toBe(403);
    expect((await call('boss', 'PATCH', { name: 'Oméga' })).status).toBe(200);
    expect(await (await call('boss')).json()).toMatchObject({ name: 'Oméga', icon: '🌱' });
  });

  it('coupe réellement l’envoi, préférence individuelle ou pas', async () => {
    const notices = [{ recipient_id: 'hand', type: 'comment_mention', page_id: 'p1' }];
    const send = vi.fn().mockResolvedValue(undefined);

    await deliverNotificationMails(db, 'w', notices, send);
    expect(send).toHaveBeenCalledTimes(1);

    send.mockClear();
    await call('boss', 'PATCH', { allowNotificationMail: false });
    await deliverNotificationMails(db, 'w', notices, send);
    expect(send).not.toHaveBeenCalled();
  });
});
