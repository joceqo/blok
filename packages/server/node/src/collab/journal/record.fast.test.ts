import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeRecord, encodeRecord, MAX_RECORD_BYTES, RECORD_HEADER_BYTES, type OperationRecord, type OperationSource } from './record.js';

interface EncodeVector {
  operationId: string; sequence: string; ticks: string; actor: string | null; source: OperationSource;
  update: string; digest: string; hex: string;
}
interface DecodeVector { name: string; status: 'Ok' | 'Incomplete' | 'Invalid'; consumed: number; error: string; hex: string; sequence: string | null }

// The reference Go codec tests consume the same .NET interoperability vectors.
const { journal } = JSON.parse(readFileSync(new URL('../../../../../../test/unit/server-conformance/fixtures/collab-disk/codecs.json', import.meta.url), 'utf8')) as {
  journal: { encode: EncodeVector[]; decode: DecodeVector[] };
};
function operation(v: EncodeVector): OperationRecord {
  return {
    operationId: v.operationId, sequence: BigInt(v.sequence), committedAtTicks: BigInt(v.ticks), actorId: v.actor, source: v.source,
    digest: Uint8Array.from(Buffer.from(v.digest, 'hex')), update: Uint8Array.from(Buffer.from(v.update, 'hex')),
  };
}

describe('journal record disk interoperability', () => {
  it.each(journal.encode)('writes and reads the exact shared bytes for sequence $sequence', v => {
    const record = operation(v);
    const bytes = Buffer.from(v.hex, 'hex');
    expect(Buffer.from(encodeRecord(record)).equals(bytes)).toBe(true);
    expect(decodeRecord(bytes)).toEqual({ status: 'ok', record, bytesRead: bytes.length, nextOffset: bytes.length });
  });
  it.each(journal.decode)('returns the reference status, consumed bytes and diagnosis for $name', v => {
    const result = decodeRecord(Buffer.from(v.hex, 'hex'));
    expect(result.status).toBe(({ Ok: 'ok', Incomplete: 'incomplete', Invalid: 'corrupt' })[v.status]);
    expect(result.bytesRead).toBe(v.consumed);
    expect(result.nextOffset).toBe(v.consumed);
    if (result.status === 'ok') expect(result.record.sequence.toString()).toBe(v.sequence);
    else expect(result.message).toBe(v.error);
  });
  it('reads adjacent records from a subarray and does not retain a reused input buffer', () => {
    const entry = operation(journal.encode[0]!);
    const bytes = encodeRecord(entry);
    const input = Buffer.concat([Buffer.alloc(3),bytes,bytes]).subarray(2);
    const first = decodeRecord(input, 1);
    expect(first.status).toBe('ok');
    const second = decodeRecord(input, first.nextOffset);
    expect(second.status).toBe('ok');
    expect(second.nextOffset).toBe(input.length);
    expect(decodeRecord(input, input.length)).toMatchObject({ status:'incomplete', nextOffset:input.length, bytesRead:0 });
    input.fill(255);
    if (second.status === 'ok') expect(second.record).toEqual(entry);
  });
  it('preserves the UTF-8 BOM and enforces every truncated boundary', () => {
    const record = { ...operation(journal.encode[0]!), actorId: '\uFEFFquelqu’un' };
    const bytes = encodeRecord(record);
    expect(decodeRecord(bytes)).toMatchObject({record});
    for (let i = 0; i < bytes.length; i++) expect(decodeRecord(bytes.subarray(0,i)).status).toBe('incomplete');
    expect(RECORD_HEADER_BYTES).toBe(38);
    expect(MAX_RECORD_BYTES).toBe(33558670);
  });
  it('rejects out-of-range fields instead of silently narrowing them', () => {
    const record = operation(journal.encode[0]!);
    for (const change of [
      { operationId: 'ABCDEF0123456789abcdef0123456789' }, { sequence: 0n }, { sequence: 1n << 64n },
      { committedAtTicks: -1n }, { committedAtTicks: 3155378976000000000n }, { source: 3 },
      { digest: new Uint8Array(31) }, { update: new Uint8Array() }, { actorId: 'é'.repeat(2049) }, { actorId: '\uD800' },
    ]) expect(() => encodeRecord({ ...record, ...change } as OperationRecord)).toThrow();
    expect(() => decodeRecord(new Uint8Array(0), 1)).toThrow(RangeError);
  });
});
