import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { PrivateS3Store } from './s3.ts';
import { LocalStore } from './local.ts';
import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';

it('reads private objects through Blok, including ranges and PDF previews, and retains legacy disk files', async () => {
  const bytes = Buffer.from('%PDF-1.4\nHello private world');
  const name = '0123456789abcdef0123456789abcdef.pdf';
  let missing = false;
  const backend = createServer((req,res) => {
    if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=access/')) { res.writeHead(403).end(); return; }
    if (req.url !== '/private/' + name || missing) { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') { missing = true; res.writeHead(204).end(); return; }
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    const data = range ? bytes.subarray(Number(range[1]),Number(range[2])+1) : bytes;
    res.writeHead(range ? 206 : 200, {'Content-Length':data.length,'Last-Modified':'Sun, 01 Nov 2026 08:00:00 GMT'});
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  backend.listen(0,'127.0.0.1');
  await once(backend, 'listening');
  const addr = backend.address();
  if (!addr || typeof addr === 'string') throw new Error('Expected TCP listener');
  const options = defaultTestHostOptions();
  options.publicUrl = 'http://localhost:8088/files';
  options.publicPath = '/files';
  options.fileBytesEnabled = true;
  const store = new PrivateS3Store({
    endpoint:`http://127.0.0.1:${addr.port}`,region:'test',bucket:'private',accessKey:'access',secretKey:'secret',
    addressing:'path',publicUrl:options.publicUrl,
  },new LocalStore(options.storageDirectory,options.publicUrl));
  options.blobStore = store;
  try {
    const path = '/files/' + name;
    expect((await invokeHost(options, {method:'HEAD',path})).body).toBe('');
    const partial = await invokeHost(options, {method:'GET',path,headers:{range:'bytes=0-4'}});
    expect(partial.status).toBe(206);
    expect(partial.body).toBe('%PDF-');
    expect(partial.headers['content-range']).toEqual([`bytes 0-4/${bytes.length}`]);
    expect((await invokeHost(options,{method:'GET',path,headers:{range:'bytes=100-200'}})).status).toBe(416);
    const pdf = await invokeHost(options,{method:'GET',path:'/file-bytes?url='+encodeURIComponent(options.publicUrl+'/'+name),headers:{range:'bytes=5-7'}});
    expect(pdf.status).toBe(206);
    expect(pdf.body).toBe('1.4');
    const old = 'f'.repeat(32) + '.txt';
    await writeFile(join(options.storageDirectory,old),'old bytes');
    expect((await invokeHost(options,{method:'GET',path:'/files/'+old})).body).toBe('old bytes');
    await store.deleteByUrl(options.publicUrl+'/'+old);
    await store.deleteByUrl(options.publicUrl+'/'+name);
    expect((await invokeHost(options,{method:'GET',path})).status).toBe(404);
  } finally {
    backend.closeAllConnections();
    await new Promise<void>((done) => backend.close(() => done()));
    await rm(options.storageDirectory,{recursive:true,force:true});
  }
});
