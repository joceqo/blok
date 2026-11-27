// Build on the target OS after installing the repository, service-node and room dependencies.
// Downloads are pinned to published SHA-256 digests. No package manager runs in the installed app.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { bundleServices, bundleSupervisor } from './bundle-runtime-services.mjs';

const targets = {
  'darwin-arm64': {
    git: 'macOS-arm64', gitDigest: 'a882ec6882416b57d212a22bac845ae27944f96cf73453a864f6a12c17863a79',
    node: 'darwin-arm64', nodeDigest: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
    pg: 'aarch64-apple-darwin', pgDigest: '2f752033b208f9a6a12ef64a9ee23bf19149cff160841980db1e221bf7d24809',
    weed: 'darwin_arm64', weedDigest: 'f2cc8368d4dc50265390803efd70e6ba77c242962902bd81a5e9520f0d262eca',
  },
  'linux-x64': {
    git: 'ubuntu-x64', gitDigest: 'e5bc3e8e80b57a5bcd8da18d59b23f5b39533d19019ac1d50b0bd34f051d111d',
    node: 'linux-x64', nodeDigest: '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
    pg: 'x86_64-unknown-linux-gnu', pgDigest: 'af316b6e42266ec0a153bdc9194e0b1b5f12c9ce4f0b13d9a96dfca77d9aaecc',
    weed: 'linux_amd64', weedDigest: 'f156c609eeaf9e5fcfeea33fd70411222005f83760aa95893c9d58eff006b45c',
  },
};
const targetName = platform() + '-' + arch();
const target = targets[targetName];
if (!target) throw new Error('Embedded journal packaging supports macOS arm64 and GNU/Linux x64.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const tauri = join(root, 'desktop/src-tauri');
const output = join(tauri, 'bundled-runtime');
const cache = process.env.BLOK_RUNTIME_CACHE || join(
  platform() === 'darwin' ? join(homedir(), 'Library/Caches') : process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'blok-bundled-runtime',
);
const nodeVersion = '24.22.3';
const pgVersion = '17.12.0';
const weedVersion = '4.55';
const nodeName = 'node-v' + nodeVersion + '-' + target.node;
const pgName = 'postgresql-' + pgVersion + '-' + target.pg;
const gitName = 'dugite-native-v2.56.1-238326e-' + target.git + '.tar.gz';
const artifacts = [
  { name: nodeName + '.tar.gz', url: 'https://nodejs.org/dist/v' + nodeVersion + '/' + nodeName + '.tar.gz', sha256: target.nodeDigest },
  { name: pgName + '.tar.gz', url: 'https://github.com/theseus-rs/postgresql-binaries/releases/download/' + pgVersion + '/' + pgName + '.tar.gz', sha256: target.pgDigest },
  { name: 'seaweedfs-' + weedVersion + '-' + target.weed + '.tar.gz', url: 'https://github.com/seaweedfs/seaweedfs/releases/download/' + weedVersion + '/' + target.weed + '.tar.gz', sha256: target.weedDigest },
  { name: 'seaweedfs-' + weedVersion + '-LICENSE', url: 'https://raw.githubusercontent.com/seaweedfs/seaweedfs/' + weedVersion + '/LICENSE', sha256: 'd789d433cc11da163273d1e39be2e8fa67642f9a58ef220d3f258fa9c14ef613' },
  { name:gitName, url:'https://github.com/desktop/dugite-native/releases/download/v2.56.1/'+gitName, sha256:target.gitDigest },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed (' + result.status + ')');
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(artifact) {
  const file = join(cache, artifact.name);
  if (await digest(file).catch(() => '') === artifact.sha256) return file;
  const temp = file + '.' + randomUUID();
  try {
    run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--retry', '2', '--output', temp, artifact.url]);
    if (await digest(temp) !== artifact.sha256) throw new Error('Digest mismatch: ' + artifact.name);
    await rename(temp, file);
    return file;
  } finally {
    await rm(temp, { force: true });
  }
}
await mkdir(cache, { recursive: true });
const work = await mkdtemp(join(tauri, '.runtime-build-'));
try {
  const ready = join(work, 'bundle');
  const bin = join(ready, 'bin');
  const pg = join(ready, 'postgres');
  const licenses = join(ready, 'licenses');
  for (const dir of [bin, pg, licenses]) await mkdir(dir, { recursive: true });
  const [nodeTar, pgTar, weedTar, weedLicense] = await Promise.all(artifacts.map(download));
  run('tar', ['-xzf', nodeTar, '-C', work, nodeName + '/bin/node', nodeName + '/LICENSE']);
  await copyFile(join(work, nodeName, 'bin/node'), join(bin, 'node'));
  await copyFile(join(work, nodeName, 'LICENSE'), join(licenses, 'Nodejs-LICENSE'));
  run('tar', ['-xzf', weedTar, '-C', bin, 'weed']);
  await copyFile(weedLicense, join(licenses, 'SeaweedFS-LICENSE'));
  const weedNotices = await readFile(join(root, 'desktop/runtime/licenses/seaweedfs-' + weedVersion + '-NOTICES.txt.gz'));
  await writeFile(join(licenses, 'SeaweedFS-NOTICES.txt'), gunzipSync(weedNotices));
  // Preserve the distribution's libraries, dynamic modules, relative symlinks and data layout.
  run('tar', ['-xzf', pgTar, '-C', work, ...['bin/initdb', 'bin/postgres', 'bin/pg_ctl', 'lib', 'share', 'COPYRIGHT', 'LICENSE', 'dependency-notices'].map(entry => pgName + '/' + entry)]);
  for (const part of ['bin', 'lib', 'share']) await rename(join(work, pgName, part), join(pg, part));
  for (const part of ['COPYRIGHT', 'LICENSE', 'dependency-notices']) await rename(join(work, pgName, part), join(licenses, 'PostgreSQL-' + part));
  for (const part of ['LICENSE', 'NOTICE']) await copyFile(join(root, part), join(licenses, 'Blok-' + part));
  const gitDir=join(ready,'git');
  await mkdir(gitDir);
  run('tar',['-xzf',join(cache,gitName),'-C',gitDir]);
  await chmod(join(bin, 'node'), 0o755);
  run(process.env.CC || 'cc', ['-Os', ...(platform() === 'darwin' ? ['-arch', 'arm64', '-mmacosx-version-min=15.0'] : []), join(root, 'desktop/runtime/flock.c'), '-o', join(bin, 'blok-flock')]);
  await Promise.all([bundleServices(ready), bundleSupervisor(ready)]);
  // Check the assembled executables with no inherited dynamic-library or Node search paths.
  const env = { PATH: '/usr/bin:/bin', HOME: work, LANG: 'C' };
  for (const [name, args] of [[join(bin, 'node'), ['--version']], [join(pg, 'bin/initdb'), ['--version']], [join(pg, 'bin/postgres'), ['--version']], [join(bin, 'weed'), ['version']], [join(bin, 'node'), [join(ready, 'room/room.mjs'), '--help']]]) {
    run(name, args, { env, cwd: work });
  }
  await writeFile(join(ready, 'runtime-manifest.json'), JSON.stringify({ platform: targetName, nodeVersion, postgresVersion: pgVersion, seaweedfsVersion: weedVersion, artifacts }, null, 2) + '\n');
  // Tauri overwrites its staging files on the next build, preserving source modes.
  run('chmod', ['-R', 'u+w', ready]);
  const previous = join(work, 'previous');
  const existed = await stat(output).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
  if (existed) await rename(output, previous);
  try { await rename(ready, output); } catch (error) {
    if (existed) await rename(previous, output);
    throw error;
  }
  console.log('Prepared ' + output);
} finally {
  await rm(work, { recursive: true, force: true });
}
