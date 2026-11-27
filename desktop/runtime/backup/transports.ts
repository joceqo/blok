import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSnapshot, type AssetStore } from './snapshot.ts';

const exec = promisify(execFile);
export interface GitDestination {
  url: string;
  user?: string;
  token?: string;
}
export async function gitTransport(runtime: string, repo: string, destination: GitDestination) {
  const url = new URL(destination.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Adresse HTTPS du dépôt requise.');
  const bin = join(runtime, 'git', 'bin'),
    helpers = join(runtime, 'git', 'libexec', 'git-core');
  const env = {
    ...process.env,
    GIT_EXEC_PATH: helpers,
    PATH: [bin, helpers, '/usr/bin', '/bin'].join(':'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_KEY_0: '',
    GIT_CONFIG_VALUE_0: '',
  };
  if (destination.token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.' + url.href + '.extraHeader';
    env.GIT_CONFIG_VALUE_0 =
      'Authorization: Basic ' +
      Buffer.from((destination.user || 'oauth2') + ':' + destination.token).toString('base64');
  }
  const git = async (args: string[]) => {
    try {
      return (
        await exec(
          join(bin, 'git'),
          [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.https.allow=always',
            '-c',
            'lfs.url=' + url.href.replace(/\/$/, '') + '/info/lfs',
            ...args,
          ],
          { cwd: repo, env, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout.trim();
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr || '');
      if (/non-fast-forward|fetch first|stale info/i.test(stderr))
        throw new Error('Une autre sauvegarde a été publiée. Réessayez.');
      if (/quota|size limit|file size|too large|budget/i.test(stderr))
        throw new Error('La destination Git refuse la taille ou le quota de cette sauvegarde.');
      throw new Error('Transfert Git impossible. Vérifiez le dépôt, les droits et la connexion.');
    }
  };
  await git(['init', '-q', '-b', 'blok-backup']);
  await git(['remote', 'add', 'origin', url.href]);
  const ref = 'refs/heads/blok-backup';
  const branches = await git(['ls-remote', '--heads', 'origin']);
  const exists = branches.split('\n').some((line) => line.endsWith('\t' + ref));
  if (exists) await git(['fetch', '-q', '--depth=1', 'origin', ref]);
  return {
    async save(folder: string) {
      const current = await readSnapshot(folder);
      if (!exists && branches) throw new Error('Choisissez un dépôt vide ou une sauvegarde Blok existante.');
      if (exists) {
        // Read only the identity from the previous commit. Never populate the working tree with remote paths on save.
        const previous = await git(['show', 'FETCH_HEAD:workspace-id']);
        if (previous !== current.workspace.id) throw new Error('Ce dépôt sauvegarde déjà un autre espace.');
        await git(['update-ref', ref, 'FETCH_HEAD']);
      }
      await writeFile(join(repo, 'workspace-id'), current.workspace.id + '\n');
      for (const name of ['workspace.json', 'complete.sha256'])
        await copyFile(join(folder, name), join(repo, name));
      await mkdir(join(repo, 'attachments'));
      for (const asset of current.assets)
        await copyFile(join(folder, 'attachments', asset.name), join(repo, 'attachments', asset.name));
      const bulky = current.assets.filter(
        (a) => a.size >= 32 * 1024 * 1024 || /\.(mp4|mov|webm|mkv|avi)$/i.test(a.name),
      );
      // Only set clean filters inside this ephemeral repository. Upload LFS before publishing the branch.
      await git(['lfs', 'install', '--local', '--skip-repo']);
      await writeFile(
        join(repo, '.gitattributes'),
        bulky.map((a) => 'attachments/' + a.name + ' filter=lfs diff=lfs merge=lfs -text').join('\n') + '\n',
      );
      await git(['add', '--', '.']);
      await git([
        '-c',
        'user.name=Blok',
        '-c',
        'user.email=desktop@blok.invalid',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-q',
        '-m',
        'Sauvegarde ' + current.capturedAt,
      ]);
      if (bulky.length) await git(['lfs', 'push', 'origin', 'HEAD']);
      await git(['push', 'origin', 'HEAD:' + ref]);
      return url.href;
    },
    async load() {
      if (!exists) throw new Error('Aucune sauvegarde Blok dans ce dépôt.');
      // Checkout only the backup format's paths. Reject links and trees outside that format before checkout.
      const tree = await git(['ls-tree', '-r', 'FETCH_HEAD']);
      for (const line of tree.split('\n')) {
        if (
          !/^100644 blob [a-f0-9]+\t(?:workspace-id|workspace\.json|complete\.sha256|\.gitattributes|attachments\/[a-f0-9]{32}(?:\.[a-z0-9]{1,15})?)$/.test(
            line,
          )
        )
          throw new Error('Arborescence Git de sauvegarde invalide.');
      }
      const attrs = await git(['show', 'FETCH_HEAD:.gitattributes']);
      if (
        attrs &&
        !attrs
          .split('\n')
          .every((s) =>
            /^attachments\/[a-f0-9]{32}(?:\.[a-z0-9]{1,15})? filter=lfs diff=lfs merge=lfs -text$/.test(s),
          )
      )
        throw new Error('Configuration LFS inattendue.');
      await git(['checkout', '--detach', 'FETCH_HEAD']);
      if (attrs) {
        await git(['lfs', 'install', '--local', '--skip-repo']);
        await git(['lfs', 'pull', 'origin']);
      }
      return repo;
    },
  };
}

// Keep each object bounded. A failed transfer can be retried without publishing an incomplete generation.
const partSize = 8 * 1024 * 1024;
export async function publishBucket(store: AssetStore, prefix: string, folder: string) {
  const s = await readSnapshot(folder);
  const headKey = prefix + '/latest.json';
  const old = await store.getObject(headKey);
  if (old && JSON.parse(old.toString()).workspace !== s.workspace.id)
    throw new Error('Ce préfixe appartient à un autre espace.');
  const gen = prefix + '/' + randomUUID();
  for (const a of s.assets) {
    const f = await open(join(folder, 'attachments', a.name), 'r');
    try {
      for (let offset = 0; offset < a.size; offset += partSize) {
        const size = Math.min(partSize, a.size - offset);
        const part = Buffer.alloc(size);
        let n = 0;
        while (n < size) {
          const r = await f.read(part, n, size - n, offset + n);
          if (!r.bytesRead) throw new Error('Lecture média interrompue.');
          n += r.bytesRead;
        }
        const key = gen + '/attachments/' + a.name + '/' + offset;
        await store.putObject(key, part);
        const received = await store.getObject(key);
        if (!received?.equals(part)) throw new Error('Le stockage distant a renvoyé des octets différents.');
      }
    } finally {
      await f.close();
    }
  }
  await store.putObject(gen + '/workspace.json', await readFile(join(folder, 'workspace.json')));
  await store.putObject(gen + '/complete.sha256', await readFile(join(folder, 'complete.sha256')));
  await store.putObject(headKey, Buffer.from(JSON.stringify({ workspace: s.workspace.id, generation: gen })));
  return gen;
}
export async function fetchBucket(store: AssetStore, generation: string, folder: string) {
  const latest = await store.getObject(generation + '/latest.json');
  if (latest) {
    const candidate = JSON.parse(latest.toString()).generation;
    if (
      typeof candidate !== 'string' ||
      !candidate.startsWith(generation + '/') ||
      !/^[0-9a-f-]{36}$/.test(candidate.slice(generation.length + 1))
    )
      throw new Error('Génération S3 invalide.');
    generation = candidate;
  }
  async function get(key: string) {
    const b = await store.getObject(generation + '/' + key);
    if (!b) throw new Error('Sauvegarde distante incomplète : ' + key);
    return b;
  }
  for (const name of ['complete.sha256', 'workspace.json'])
    await writeFile(join(folder, name), await get(name), { flag: 'wx' });
  const s = await readSnapshot(folder);
  await mkdir(join(folder, 'attachments'));
  for (const a of s.assets) {
    const f = await open(join(folder, 'attachments', a.name), 'wx', 0o600);
    const hash = createHash('sha256');
    try {
      for (let offset = 0; offset < a.size; offset += partSize) {
        const part = await get('attachments/' + a.name + '/' + offset);
        if (part.length !== Math.min(partSize, a.size - offset))
          throw new Error('Taille du média incorrecte.');
        hash.update(part);
        await f.writeFile(part);
      }
    } finally {
      await f.close();
    }
    if (hash.digest('hex') !== a.digest) throw new Error('Média distant endommagé.');
  }
}
