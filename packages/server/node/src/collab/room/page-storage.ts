import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createScanner, SyntaxKind } from 'jsonc-parser';
import { applyUpdate, Doc } from 'yjs';
import { inspectJournal } from '../journal/inspect.ts';
import { envelope, exportPage, seedUpdate, type Snapshot } from './page-document.ts';
import { existingDirectory, initializePage, pageDirectory, syncDirectory } from './page-seed.ts';

interface Head {
  version: string;
  lineage: string | null;
  sequence: string | null;
}
interface Remote extends Head {
  data: Snapshot;
}
interface Anchor extends Head {
  pageId: string;
  hash: string;
  extra: Record<string, unknown>;
}

const unsigned = /^(0|[1-9][0-9]*)$/;
function eqHead(a: Head, b: Head) {
  return a.version === b.version && a.lineage === b.lineage && a.sequence === b.sequence;
}
function fingerprint(data: Snapshot) {
  // PG jsonb serialization has a stable key order, but insertion order in Yjs may differ.
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(data)))
    .digest('hex');
}
function anchor(pageId: string, r: Remote): Anchor {
  return {
    pageId,
    version: r.version,
    lineage: r.lineage,
    sequence: r.sequence,
    hash: fingerprint(r.data),
    extra: envelope(r.data),
  };
}
function decimal(text: string) {
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  const [whole, frac = ''] = mantissa!.replace(/^-/, '').split('.');
  const digits = (whole! + frac).replace(/^0+/, '');
  if (!digits) return '0';
  const trimmed = digits.replace(/0+$/, '');
  return (
    (text.startsWith('-') ? '-' : '') +
    trimmed +
    'e' +
    String(BigInt(exponent) - BigInt(frac.length) + BigInt(digits.length - trimmed.length))
  );
}
function parseLossless(text: string) {
  const scanner = createScanner(text, true);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token !== SyntaxKind.NumericLiteral) continue;
    const lexeme = text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength());
    const n = Number(lexeme);
    if (
      !Number.isFinite(n) ||
      (Number.isInteger(n) && !Number.isSafeInteger(n)) ||
      decimal(lexeme) !== decimal(String(n))
    )
      throw new Error('Unrepresentable JSON number in projection');
  }
  return JSON.parse(text);
}
function validHead(v: Head) {
  return (
    typeof v.version === 'string' &&
    unsigned.test(v.version) &&
    ((v.lineage === null && v.sequence === null) ||
      (typeof v.lineage === 'string' &&
        /^[a-f0-9]{32}$/.test(v.lineage) &&
        typeof v.sequence === 'string' &&
        unsigned.test(v.sequence)))
  );
}
export async function preparePageStorage(root: string, pageId: string, origin: string, secret: string) {
  const endpoint = new URL(origin);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    secret.length < 32
  )
    throw new Error('Invalid projection endpoint configuration');
  endpoint.pathname = '/internal/documents/' + encodeURIComponent(pageId);
  const auth = { Authorization: 'Bearer ' + secret };
  async function read(): Promise<Remote> {
    const res = await fetch(endpoint, {
      headers: auth,
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error('Projection lookup failed: ' + res.status);
    }
    const v = parseLossless(await res.text()) as Remote;
    if (
      !v ||
      !validHead(v) ||
      (v.data !== null && (!v.data || typeof v.data !== 'object' || Array.isArray(v.data)))
    )
      throw new Error('Invalid canonical projection');
    return v;
  }
  const directory = pageDirectory(root, pageId);
  const disk = join(directory, 'node-projection.json');
  let cursor: Anchor;
  let lineage: string;
  if (!(await existingDirectory(directory))) {
    const r = await read();
    if (r.lineage !== null)
      throw new Error('Projection already has a lineage; the matching journal must be restored');
    await initializePage(root, pageId, seedUpdate(r.data), JSON.stringify(anchor(pageId, r)));
  }
  async function remember(next: Anchor) {
    const temp = disk + '.' + randomUUID();
    const file = await open(temp, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, disk);
      await syncDirectory(directory);
      cursor = next;
    } finally {
      await rm(temp, { force: true });
    }
  }
  function match(remote: Remote, data: Snapshot, seq: bigint) {
    return (
      remote.lineage === lineage && remote.sequence === String(seq) && isDeepStrictEqual(remote.data, data)
    );
  }
  async function publish(seq: bigint, data: Snapshot) {
    const expect = cursor;
    const headers = {
      ...auth,
      'Content-Type': 'application/json',
      'Blok-Doc-If-Match': 'exact',
      'Blok-Doc-Version': expect.version,
      'Blok-Doc-Expected-Lineage': expect.lineage ?? '',
      'Blok-Doc-Expected-Sequence': expect.sequence ?? '',
      'Blok-Doc-Lineage': lineage,
      'Blok-Doc-Sequence': String(seq),
    };
    const res = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error('Projection compare-and-swap failed: ' + res.status);
    }
    const ack = (await res.json()) as { version?: string };
    if (typeof ack.version !== 'string' || !unsigned.test(ack.version))
      throw new Error('Invalid projection receipt');
    await remember(anchor(pageId, { data, version: ack.version, lineage, sequence: String(seq) }));
  }
  return {
    directory,
    async attach(doc: Doc, activeLineage: string, head: bigint) {
      lineage = activeLineage;
      const remote = await read();
      if (remote.lineage !== null && (remote.lineage !== lineage || BigInt(remote.sequence!) > head))
        throw new Error('Projection disagrees with the journal lineage or is ahead of it');
      try {
        cursor = parseLossless(await readFile(disk, 'utf8')) as Anchor;
        if (
          !validHead(cursor) ||
          cursor.pageId !== pageId ||
          typeof cursor.hash !== 'string' ||
          !cursor.extra ||
          typeof cursor.extra !== 'object'
        )
          throw new Error('Invalid projection recovery metadata');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Adopt a Go journal only after proving its projected prefix matches PG.
        const target = BigInt(remote.sequence ?? '0');
        const prefix = new Doc();
        try {
          const info = await inspectJournal(directory, (f) => {
            if (f.sequence <= target) applyUpdate(prefix, f.update);
          });
          if (
            info.integrity !== 'ok' ||
            !info.manifest ||
            info.manifest.checkpointThrough > target ||
            !isDeepStrictEqual(exportPage(prefix, envelope(remote.data)), remote.data ?? { blocks: [] })
          )
            throw new Error('Unverified pre-existing journal projection');
        } finally {
          prefix.destroy();
        }
        await remember(anchor(pageId, remote));
      }
      const data = exportPage(doc, cursor.extra);
      const target =
        head === 0n && remote.data === null && isDeepStrictEqual(data, { blocks: [] }) ? null : data;
      if (
        match(remote, target, head) &&
        (eqHead(cursor, remote) || BigInt(remote.version) === BigInt(cursor.version) + 1n)
      ) {
        await remember(anchor(pageId, remote));
        return;
      }
      if (!eqHead(cursor, remote) || fingerprint(remote.data) !== cursor.hash)
        throw new Error('Canonical projection changed since the journal was last confirmed');
      await publish(head, target);
    },
    validate(doc: Doc) {
      return exportPage(doc, cursor.extra);
    },
    publish,
  };
}
export type PageStorage = Awaited<ReturnType<typeof preparePageStorage>>;
