import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const script = join(root, 'scripts', 'blok-upload-image.mjs');
const token = 'test-mcp-secret-never-print';
const imageBytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(220_000, 83)]);
const asset = '/files/0123456789abcdef0123456789abcdef.png';
const reply = value => ({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(value)}]}});

async function fixture(t, handler) {
  const scratch = await mkdtemp(join(tmpdir(), 'blok-upload-image-'));
  const file = join(scratch, 'dashboard.wrong-extension');
  await writeFile(file, imageBytes);
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, {recursive:true,force:true});
  });
  return {scratch,file,endpoint};
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env:{...process.env,BLOK_MCP_TOKEN:token,BLOK_MCP_URL:'',...env},
      stdio:['ignore','pipe','pipe'],
    });
    const output = {stdout:'',stderr:''};
    child.stdout.on('data', bytes => { output.stdout += bytes; });
    child.stderr.on('data', bytes => { output.stderr += bytes; });
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Upload CLI did not finish')); }, 12_000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); resolve({code,...output}); });
  });
}

function jsonResponse(response, body) {
  response.writeHead(200, {'content-type':'application/json'});
  response.end(JSON.stringify(body));
}

test('uploads a 220 KB local screenshot byte-for-byte with MCP credentials, no base64 output', async t => {
  const seen = [];
  const f = await fixture(t, async (request, response) => {
    seen.push({headers:request.headers,url:request.url,body:await readRequest(request)});
    jsonResponse(response, reply({url:asset}));
  });
  const result = await cli(['equipe', f.file, '--server', f.endpoint]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {url:asset});
  assert.equal(result.stderr, '');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${token}`);
  assert.equal(seen[0].url, '/mcp');
  assert.equal(seen[0].body.method, 'tools/call');
  assert.equal(seen[0].body.params.name, 'blok_upload_image');
  const args = seen[0].body.params.arguments;
  assert.deepEqual(Object.keys(args).sort(), ['dataUrl','workspace']);
  assert.equal(args.workspace, 'equipe');
  assert.equal(args.dataUrl, `data:image/png;base64,${imageBytes.toString('base64')}`);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stdout.includes(imageBytes.subarray(0, 30).toString('base64')));
});

test('accepts a configured origin and routes only the HTTPS URL input to MCP', async t => {
  const seen = [];
  const f = await fixture(t, async (request, response) => {
    seen.push(await readRequest(request));
    jsonResponse(response, reply({url:asset}));
  });
  const result = await cli(['equipe','--url','https://images.example.test/dashboard.png'], {BLOK_MCP_URL:new URL(f.endpoint).origin});
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(seen[0].params.arguments, {workspace:'equipe',url:'https://images.example.test/dashboard.png'});
});

test('normalizes the returned asset path instead of echoing untrusted URL text', async t => {
  const f = await fixture(t, async (request, response) => {
    await readRequest(request);
    jsonResponse(response, reply({url:`/${token}/..${asset}`}));
  });
  const result = await cli(['equipe',f.file,'--server',f.endpoint]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {url:asset});
  assert.ok(!result.stdout.includes(token));
});

test('returns a matching SSE result without waiting for the event stream to close', async t => {
  const f = await fixture(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, {'content-type':'text/event-stream'});
    response.write(': keepalive\r\n\r\nevent: message\r\nda');
    response.write(`ta: ${JSON.stringify(reply({url:asset}))}\r\n\r\n`);
    // No end(): a persistent MCP event stream is not an upload still in progress.
  });
  const result = await cli(['equipe',f.file,'--server',f.endpoint]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {url:asset});
});

for (const [label, body] of [
  ['tool refusal',{jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:`${token} ${imageBytes.subarray(0, 200).toString('base64')}`} ]}}],
  ['JSON-RPC refusal',{jsonrpc:'2.0',id:1,error:{code:-32602,message:token}}],
  ['wrong request ID',{...reply({url:asset}),id:2}],
  ['invalid asset URL',reply({url:'javascript:alert(1)'})],
]) {
  test(`fails closed on ${label} and keeps the credential and source bytes out of logs`, async t => {
    const f = await fixture(t, async (request, response) => { await readRequest(request); jsonResponse(response, body); });
    const result = await cli(['equipe',f.file,'--server',f.endpoint]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(token));
    assert.ok(!result.stderr.includes(imageBytes.subarray(0, 30).toString('base64')));
    assert.ok(result.stderr.length < 500);
  });
}

test('does not forward a bearer credential or the image to a redirected endpoint', async t => {
  const redirected = [];
  const second = await fixture(t, async (request, response) => { redirected.push(await readRequest(request)); jsonResponse(response, reply({url:asset})); });
  const f = await fixture(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(307, {location:second.endpoint}); response.end();
  });
  const result = await cli(['equipe',f.file,'--server',f.endpoint]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.deepEqual(redirected, []);
});

test('bounds the JSON response before printing untrusted content', async t => {
  const f = await fixture(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify(reply({url:asset,padding:'x'.repeat(70_000)})));
  });
  const result = await cli(['equipe',f.file,'--server',f.endpoint]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length < 500);
});

test('bounds SSE streams even if no result event is delivered', async t => {
  const f = await fixture(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, {'content-type':'text/event-stream'});
    response.write(`:${'x'.repeat(70_000)}`);
  });
  const result = await cli(['equipe',f.file,'--server',f.endpoint]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
});

for (const source of [
  ['missing credentials', [], {BLOK_MCP_TOKEN:''}],
  ['both a local path and URL', ['--url','https://images.example.test/a.png'], {}],
  ['non-HTTPS image URL', ['--url','http://images.example.test/a.png'], {}, true],
]) {
  test(`rejects ${source[0]} before sending any request`, async t => {
    const seen = [];
    const f = await fixture(t, (request, response) => { seen.push(request.url); jsonResponse(response, reply({url:asset})); });
    const result = await cli(['equipe',...(source[3] ? [] : [f.file]),...source[1],'--server',f.endpoint],source[2]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.deepEqual(seen, []);
  });
}

for (const endpoint of ['https://user:secret@example.test/mcp','https://example.test/mcp?token=secret','https://example.test/mcp#part','http://example.test/mcp']) {
  test(`rejects an unsafe configured endpoint: ${new URL(endpoint).origin}`, async t => {
    const f = await fixture(t, (_request, response) => jsonResponse(response, reply({url:asset})));
    const result = await cli(['equipe',f.file,'--server',endpoint]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('secret'));
  });
}

test('does not mistake a hostname beginning with 127 for a loopback IP', async t => {
  const { uploadImage } = await import(pathToFileURL(script).href);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async () => {
    seen.push(true);
    return new Response(JSON.stringify(reply({url:asset})), {headers:{'content-type':'application/json'}});
  });
  await assert.rejects(uploadImage({workspace:'equipe',url:'https://images.example.test/a.png',server:'http://127.attacker.example/mcp',token}), /endpoint/i);
  assert.deepEqual(seen, []);
});

test('rejects unsupported file content, non-files and sources larger than 25 MiB before upload', async t => {
  const seen = [];
  const f = await fixture(t, (request, response) => { seen.push(request.url); jsonResponse(response, reply({url:asset})); });
  const svg = join(f.scratch,'fake.png');
  const large = join(f.scratch,'large.png');
  const directory = join(f.scratch,'folder');
  await writeFile(svg,'<svg onload="alert(1)"/>');
  await writeFile(large,Buffer.alloc(25 * 1024 * 1024 + 1));
  await mkdir(directory);
  for (const file of [svg,large,directory]) {
    const result = await cli(['equipe',file,'--server',f.endpoint]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(seen, []);
});

test('uses a bounded deadline for servers that never answer', async t => {
  const f = await fixture(t, async request => { await readRequest(request); });
  const { uploadImage } = await import(pathToFileURL(script).href);
  await assert.rejects(uploadImage({workspace:'equipe',filePath:f.file,server:f.endpoint,token,timeoutMs:40}), /timed out|request failed/i);
});

test('help works without credentials and does not expose the environment', async () => {
  const result = await cli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout,/BLOK_MCP_TOKEN/);
  assert.ok(!result.stdout.includes(token));
});
