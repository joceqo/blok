import { describe, expect, it } from 'vitest';

import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';

function multipartBody(boundary: string, fileName: string, content: string): Uint8Array {
  const text =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return new TextEncoder().encode(text);
}

describe('@fast upload and delete', () => {
  it('uploads a multipart file and returns JSON with url', async () => {
    const boundary = 'fastboundary';
    const response = await invokeHost(defaultTestHostOptions(), {
      method: 'POST',
      path: '/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody(boundary, 'note.txt', 'hello upload'),
    });
    expect(response.status).toBe(200);
    const json = JSON.parse(response.body.trim()) as { url: string; fileName: string; size: number };
    expect(json.fileName).toBe('note.txt');
    expect(json.size).toBe('hello upload'.length);
    expect(json.url).toContain('.txt');
  });

  it('deletes a file by url', async () => {
    const boundary = 'deleteboundary';
    const options = defaultTestHostOptions();
    const uploaded = await invokeHost(options, {
      method: 'POST',
      path: '/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody(boundary, 'gone.txt', 'delete me'),
    });
    const { url } = JSON.parse(uploaded.body.trim()) as { url: string };
    const deleted = await invokeHost(options, {
      method: 'POST',
      path: '/delete',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }) + '\n',
    });
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body.trim())).toEqual({ success: 1 });
  });
});