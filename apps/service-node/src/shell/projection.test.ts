import { describe, expect, it } from 'vitest';
import { projectionDecision, readProjectionHeaders, type ProjectionHead } from './projection.js';

const stored: ProjectionHead = { version: '3', lineage: 'first', sequence: '10' };

describe('shell projection concurrency', () => {
  it('applies an edit against the loaded version and refuses a stale writer', () => {
    expect(projectionDecision(stored, { ...stored, sequence: '11' }, false)).toBe('write');
    expect(projectionDecision(stored, { ...stored, version: '2', sequence: '11' }, false)).toBe('conflict');
  });

  it('acknowledges a retry after a lost response without incrementing the version', () => {
    expect(projectionDecision(stored, { ...stored, version: '2' }, true)).toBe('retry');
    expect(projectionDecision(stored, stored, false)).toBe('conflict');
  });

  it('rejects an older journal snapshot even with the current version', () => {
    expect(projectionDecision(stored, { ...stored, sequence: '9' }, false)).toBe('conflict');
  });

  it('requires a matching version to switch lineages', () => {
    expect(projectionDecision(stored, { ...stored, lineage: 'second', sequence: '0' }, false)).toBe('write');
    for (const version of ['', '1']) {
      expect(projectionDecision(stored, { version, lineage: 'second', sequence: '0' }, false)).toBe('conflict');
    }
  });

  it('handles a journal recovery before the version read returns', () => {
    expect(projectionDecision(stored, { ...stored, version: '', sequence: '11' }, false)).toBe('write');
    expect(projectionDecision({ version: '0', sequence: null, lineage: null }, { ...stored, version: '' }, false)).toBe('write');
  });

  it('reads unsigned sequence numbers without losing precision', () => {
    const headers = new Headers({ 'Blok-Doc-Sequence': '18446744073709551615', 'Blok-Doc-Lineage': 'first' });
    expect(readProjectionHeaders(headers)?.sequence).toBe('18446744073709551615');
    headers.set('Blok-Doc-Sequence', '18446744073709551616');
    expect(readProjectionHeaders(headers)).toBeUndefined();
    headers.delete('Blok-Doc-Sequence');
    expect(readProjectionHeaders(headers)).toBeUndefined();
  });
});
