import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../../apps/service-node/src/db/pool.ts';
import { LocalStore } from '../../../packages/server/node/src/blob/local.ts';
import { S3Store, PrivateS3Store } from '../../../packages/server/node/src/blob/s3.ts';
import { openInstance } from '../instance.ts';
import { capture, restore } from './snapshot.ts';
import { gitTransport, publishBucket, fetchBucket } from './transports.ts';

interface Options {
  action: 'save' | 'restore';
  kind: 'folder' | 'git' | 's3';
  workspace: string;
  url: string;
  user: string;
  token: string;
  bucket: string;
  region: string;
  prefix: string;
}
async function chooseFolder(save: boolean) {
  const prompt = save ? 'Choisir un dossier pour la sauvegarde' : 'Ouvrir le dossier de la sauvegarde Blok';
  if (process.platform === 'darwin') {
    try {
      return (
        await promisify(execFile)('/usr/bin/osascript', [
          '-e',
          'POSIX path of (choose folder with prompt "' + prompt + '")',
        ])
      ).stdout.trimEnd();
    } catch (e) {
      if (String((e as { stderr?: string }).stderr).includes('(-128)')) return null;
      throw e;
    }
  }
  try {
    return (
      await promisify(execFile)('zenity', ['--file-selection', '--directory', '--title=' + prompt])
    ).stdout.trimEnd();
  } catch (e) {
    if ((e as { code?: number }).code === 1) return null;
    throw e;
  }
}
export async function runWorkspaceBackup(
  data: string,
  runtime: string,
  options: Options,
  pickFolder = chooseFolder,
) {
  if (!['save', 'restore'].includes(options.action) || !['folder', 'git', 's3'].includes(options.kind))
    throw new Error('Destination inconnue.');
  const save = options.action === 'save';
  const selected = options.kind === 'folder' ? await pickFolder(save) : null;
  if (options.kind === 'folder' && !selected) return { cancelled: true };
  const instance = await openInstance(data);
  const { ports, secrets } = instance;
  const origin = 'http://127.0.0.1:' + ports.public;
  const media = new PrivateS3Store(
    {
      endpoint: 'http://127.0.0.1:' + ports.s3,
      bucket: 'blok-assets',
      region: 'us-east-1',
      addressing: 'path',
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      publicUrl: origin + '/files',
    },
    new LocalStore(join(data, 'uploads'), origin + '/files'),
  );
  // The shell can become ready before the separate embedded object store.
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      await media.checkBucket();
      break;
    } catch {
      if (Date.now() >= deadline)
        throw new Error('Stockage local indisponible. Réessayez après son démarrage.');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const db = createPool(
    'postgresql://blok:' + secrets.postgres + '@127.0.0.1:' + ports.postgres + '/postgres',
  );
  const stage = await mkdtemp(join(save && selected ? selected : tmpdir(), '.blok-backup-'));
  try {
    if (save) await capture(db, media, origin, data, options.workspace, stage);
    let folder = selected || stage;
    if (options.kind === 'git') {
      const repo = await mkdtemp(join(tmpdir(), 'blok-git-'));
      try {
        const git = await gitTransport(runtime, repo, options);
        if (save) return { location: await git.save(stage) };
        return { workspace: await restore(db, media, origin, await git.load()) };
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
    if (options.kind === 's3') {
      const url = new URL(options.url);
      if (
        !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error('Point de terminaison HTTPS S3 invalide.');
      if (
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
        !/^[a-z0-9-]{1,32}$/.test(options.region) ||
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(options.prefix)
      )
        throw new Error('Bucket, région ou préfixe invalide.');
      const bucket = new S3Store({
        endpoint: url.origin,
        region: options.region,
        bucket: options.bucket,
        accessKey: options.user,
        secretKey: options.token,
        addressing: 'path',
        publicUrl: url.origin,
      });
      if (save) return { location: await publishBucket(bucket, options.prefix, stage) };
      await fetchBucket(bucket, options.prefix, stage);
      folder = stage;
    }
    if (!save) return { workspace: await restore(db, media, origin, folder) };
    const location = join(selected!, 'Blok-' + new Date().toISOString().slice(0, 10) + '-' + randomUUID());
    await rename(stage, location);
    return { location };
  } finally {
    await db.end();
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const part of process.stdin) input += part;
  try {
    const result = await runWorkspaceBackup(process.argv[2], process.argv[3], JSON.parse(input));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // Provider error bodies can contain signed URLs. Keep runtime secrets out of the UI.
    const msg = error instanceof Error ? error.message : 'La sauvegarde a échoué.';
    process.stdout.write(
      JSON.stringify({
        error: msg.startsWith('blobstore:') ? 'Le stockage des pièces jointes a refusé le transfert.' : msg,
      }),
    );
  }
}
