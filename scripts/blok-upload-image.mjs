#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const REQUEST_ID = 1;
const HELP = `Upload a private workspace image through the hosted Blok MCP.

Usage:
  node scripts/blok-upload-image.mjs <workspace> <file> [--server URL]
  node scripts/blok-upload-image.mjs <workspace> --url HTTPS_URL [--server URL]

BLOK_MCP_TOKEN supplies the Bearer credential; it is never read from argv.
BLOK_MCP_URL supplies the MCP endpoint when --server is omitted. An origin
without a path is expanded to /mcp. HTTPS is required except on localhost.

Local PNG, JPEG, GIF and WebP files are read directly, up to 25 MiB. Their
base64 is built in memory, never printed. --url asks the hosted MCP to import
an HTTPS image. The result on stdout is only JSON containing its asset URL.
`;

class UploadError extends Error {}

function endpointFor(raw) {
  try {
    const endpoint = new URL(raw);
    const local = endpoint.hostname === 'localhost' || endpoint.hostname === 'localhost.' || endpoint.hostname === '[::1]' || (isIP(endpoint.hostname) === 4 && endpoint.hostname.startsWith('127.'));
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local))) throw new Error();
    if (endpoint.pathname === '/') endpoint.pathname = '/mcp';
    return endpoint;
  } catch {
    throw new UploadError('Set a valid HTTPS MCP endpoint with --server or BLOK_MCP_URL.');
  }
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new UploadError('Use a PNG, JPEG, GIF or WebP file.');
}

/** Read one regular file, limiting the bytes actually read even if it grows after stat. */
export async function readImageFile(filePath) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new UploadError('Could not open the local image file.');
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new UploadError('The image must be a regular file.');
    if (stat.size > MAX_SOURCE_BYTES) throw new UploadError('The image source exceeds 25 MiB.');
    const chunks = [];
    const state = {length:0};
    const buffer = Buffer.alloc(64 * 1024);
    while (state.length <= MAX_SOURCE_BYTES) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, MAX_SOURCE_BYTES + 1 - state.length));
      if (bytesRead === 0) break;
      state.length += bytesRead;
      if (state.length > MAX_SOURCE_BYTES) throw new UploadError('The image source exceeds 25 MiB.');
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const bytes = Buffer.concat(chunks, state.length);
    return `data:${imageType(bytes)};base64,${bytes.toString('base64')}`;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError('Could not read the local image file.');
  } finally {
    await file.close().catch(() => {});
  }
}

function sourceUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || raw.length > 4096) throw new Error();
    return url.href;
  } catch {
    throw new UploadError('The image URL must be HTTPS without credentials or a fragment.');
  }
}

function uploadedAsset(envelope, endpoint) {
  if (!envelope || envelope.jsonrpc !== '2.0' || envelope.id !== REQUEST_ID || envelope.error ||
    !envelope.result || envelope.result.isError === true || !Array.isArray(envelope.result.content)) {
    throw new UploadError('The MCP server refused the image upload.');
  }
  const text = envelope.result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text;
  try {
    const value = JSON.parse(text);
    if (typeof value?.url !== 'string') throw new Error();
    const url = new URL(value.url, endpoint);
    if (url.origin !== endpoint.origin || url.username || url.password || url.search || url.hash ||
      !/^\/files\/[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) throw new Error();
    return {url:url.pathname};
  } catch {
    throw new UploadError('The MCP server returned no valid workspace image URL.');
  }
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new UploadError('The MCP server returned an invalid response.'); }
}

async function readResult(response, endpoint) {
  if (!response.body) throw new UploadError('The MCP server returned an empty response.');
  const reader = response.body.getReader();
  const state = {bytes:0,buffer:''};
  const decoder = new TextDecoder();
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const eventStream = contentType === 'text/event-stream';
  try {
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength > MAX_RESPONSE_BYTES) throw new UploadError('The MCP response exceeds the upload response limit.');
    if (!eventStream && contentType !== 'application/json') throw new UploadError('The MCP server returned an invalid response type.');
    while (true) {
      const {value,done} = await reader.read();
      if (done) break;
      state.bytes += value.byteLength;
      if (state.bytes > MAX_RESPONSE_BYTES) throw new UploadError('The MCP response exceeds the upload response limit.');
      state.buffer += decoder.decode(value, {stream:true});
      if (!eventStream) continue;
      while (true) {
        const boundary = /\r\n\r\n|\n\n|\r\r/.exec(state.buffer);
        if (!boundary) break;
        const event = state.buffer.slice(0, boundary.index);
        state.buffer = state.buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const envelope = parseJson(data);
        if (envelope?.id === REQUEST_ID) return uploadedAsset(envelope, endpoint);
      }
    }
    state.buffer += decoder.decode();
    if (eventStream) throw new UploadError('The MCP event stream ended without an upload result.');
    return uploadedAsset(parseJson(state.buffer), endpoint);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Upload a local file or ask the remote service to import an HTTPS URL; never log source bytes or credentials. */
export async function uploadImage({workspace,filePath,url,server,token,timeoutMs = DEFAULT_TIMEOUT_MS}) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new UploadError('Provide a workspace slug.');
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new UploadError('Set BLOK_MCP_TOKEN to a dedicated MCP token.');
  const endpoint = endpointFor(server);
  if (Boolean(filePath) === Boolean(url)) throw new UploadError('Provide exactly one local file or --url HTTPS_URL.');
  const args = {workspace:workspace.trim(), ...(filePath ? {dataUrl:await readImageFile(filePath)} : {url:sourceUrl(url)})};
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method:'POST',redirect:'manual',signal,
      headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':`Bearer ${token.trim()}`},
      body:JSON.stringify({jsonrpc:'2.0',id:REQUEST_ID,method:'tools/call',params:{name:'blok_upload_image',arguments:args}}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UploadError(`The MCP upload failed (HTTP ${response.status}).`);
    }
    return await readResult(response, endpoint);
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(signal.aborted ? 'The MCP upload timed out.' : 'The MCP upload request failed.');
  }
}

function argumentsFor(argv, env) {
  const state = {server:env.BLOK_MCP_URL,url:undefined,positional:[],literal:false};
  for (const [index, value] of argv.entries()) {
    if (!state.literal && value === '--') { state.literal = true; continue; }
    if (!state.literal && (value === '--server' || value === '--url')) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new UploadError('Provide a value after --server or --url.');
      if (value === '--server') state.server = next;
      else state.url = next;
      continue;
    }
    if (!state.literal && index > 0 && (argv[index - 1] === '--server' || argv[index - 1] === '--url')) continue;
    if (!state.literal && value.startsWith('--')) throw new UploadError('Unknown option; use --help for usage.');
    state.positional.push(value);
  }
  if (state.positional.length !== (state.url ? 1 : 2)) throw new UploadError('Provide a workspace and one local file, or a workspace and --url HTTPS_URL.');
  return {workspace:state.positional[0],filePath:state.positional[1],url:state.url,server:state.server,token:env.BLOK_MCP_TOKEN};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes('--help')) process.stdout.write(HELP);
  else {
    try {
      const result = await uploadImage(argumentsFor(process.argv.slice(2), process.env));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      const message = error instanceof UploadError ? error.message : 'The image upload failed.';
      process.stderr.write(`blok-upload-image: ${message}\n`);
      process.exitCode = 1;
    }
  }
}
