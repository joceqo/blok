import busboy from 'busboy';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extension, newKey } from '../blob/key.ts';
import type { PrivateS3Store } from '../blob/s3.ts';
import { BodyError } from '../http/body.ts';
import type { Request } from '../http/request.ts';
import type { ResponseWriter } from '../http/response.ts';
import { writePlain } from '../route/respond.ts';

const fileLimit = 1024 * 1024 * 1024;
export async function embeddedFileUpload(store: PrivateS3Store, request: Request, response: ResponseWriter) {
  request.setBodyLimit(fileLimit + 65536);
  const input = request.takeBody();
  if (!input) return writePlain(request, response, 400, 'missing file\n');
  const temp = await mkdtemp(join(tmpdir(), 'blok-media-'));
  const file = join(temp, 'body');
  let pending: Promise<void> | undefined, writeError: unknown;
  let size = 0,
    name = '',
    mime = '',
    invalid = false,
    tooLarge = false;
  const hash = createHash('sha256');
  try {
    try {
      const parser = busboy({
        headers: { 'content-type': request.headers().get('content-type') ?? '' },
        limits: { files: 1, fileSize: fileLimit + 1, fields: 16, fieldSize: 4096, parts: 18 },
      });
      parser.on('filesLimit', () => {
        invalid = true;
      });
      parser.on('partsLimit', () => {
        invalid = true;
      });
      parser.on('file', (field, stream, info) => {
        if (field !== 'file' || pending) {
          invalid = true;
          stream.resume();
          return;
        }
        name = info.filename;
        mime = info.mimeType;
        stream.on('limit', () => {
          tooLarge = true;
        });
        const count = new Transform({
          transform(chunk, _encoding, cb) {
            size += chunk.length;
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        pending = pipeline(stream, count, createWriteStream(file, { flags: 'wx', mode: 0o600 })).catch(
          (error) => {
            writeError = error;
            parser.destroy(error);
          },
        );
      });
      async function* chunks() {
        const b = new Uint8Array(65536);
        for (;;) {
          const n = await input!.read(b);
          if (n === 0) return;
          yield Buffer.from(b.subarray(0, n));
        }
      }
      await pipeline(Readable.from(chunks()), parser);
      await pending;
      if (tooLarge || size > fileLimit) return writePlain(request, response, 413, 'file too large\n');
      if (writeError || invalid || !pending) return writePlain(request, response, 400, 'invalid file\n');
    } catch (error) {
      console.warn('Embedded file upload interrupted', error);
      return writePlain(request, response, error === BodyError.TooLarge ? 413 : 400, 'upload interrupted\n');
    }
    const key = newKey(extension(name));
    try {
      await store.putStream(key, createReadStream(file), size, hash.digest('hex'), mime);
    } catch {
      return writePlain(request, response, 502, 'upload failed\n');
    }
    response.headersMut().set('Content-Type', 'application/json');
    await response.start(200);
    await response.write(
      Buffer.from(
        JSON.stringify({
          url: store.options.publicUrl.replace(/\/$/, '') + '/' + key,
          fileName: name,
          size,
          mimeType: mime,
        }),
      ),
    );
  } finally {
    await pending;
    await rm(temp, { recursive: true, force: true });
  }
}
