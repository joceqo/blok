import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, rename, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Publish all bootstrap files together. A crash before rename leaves only a
// private staging directory; a Go or Node creator with a populated target wins.
async function writeSynced(path: string, bytes: Uint8Array) {
  const file = await open(path,'wx',0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export async function syncDirectory(path: string) {
  const dir = await open(path,'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
export function pageDirectory(root: string, pageId: string) {
  return join(resolve(root),createHash('sha256').update(pageId).digest('hex')+'.journal');
}
export async function existingDirectory(path: string) {
  try { const info = await lstat(path); if (!info.isDirectory()) throw new Error('Expected a journal directory'); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

export async function initializePage(root: string, pageId: string, update: Uint8Array, anchor: string) {
  await mkdir(root,{recursive:true,mode:0o700});
  const target = pageDirectory(root,pageId);
  const temp = await mkdtemp(join(root,'.seed-'));
  try {
    const frame = Buffer.alloc(4+update.length);
    frame.writeInt32LE(update.length); frame.set(update,4);
    const base = Buffer.alloc(24+frame.length);
    base.write('BKJB'); base[4]=1; base.writeBigInt64LE(BigInt(frame.length),16); base.set(frame,24);
    await writeSynced(join(temp,'baseline.1.1'),Buffer.concat([base,createHash('sha256').update(base).digest()]));
    await writeSynced(join(temp,'journal.1.1'),new Uint8Array());
    const slots = Buffer.alloc(256);
    // Go publishes WriteCounter&1; both generation and generationFence name the sealed files.
    const slot = slots.subarray(128);
    slot.write('BKJM'); slot[4]=2; slot[5]=1;
    for (const offset of [8,16,24,68]) slot.writeBigUInt64LE(1n,offset);
    slot.writeInt32LE(2,32); slot.writeBigInt64LE(1n,36);
    slot.set(randomBytes(16),44);
    slot.set(createHash('sha256').update(slot.subarray(0,96)).digest(),96);
    await writeSynced(join(temp,'manifest'),slots);
    await writeSynced(join(temp,'node-projection.json'),Buffer.from(anchor));
    await syncDirectory(temp);
    try { await rename(temp,target); }
    catch (err) {
      if (!['ENOTEMPTY','EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '') || !await existingDirectory(target)) throw err;
    }
    await syncDirectory(root);
  } finally { await rm(temp,{recursive:true,force:true}); }
}
