import { expect, it } from 'vitest';
import { HistoryChangeWindow } from './history-change-window.ts';

const point = (sequence: number) => ({ lineage: 'a', sequence, committedAt: sequence });
it('includes properties in the byte budget and resumes at the oldest visible point after cutting', () => {
  const window = new HistoryChangeWindow();
  const value = 'é'.repeat(512 * 1024);
  for (let sequence = 1; sequence <= 3; sequence++) {
    window.add(point(sequence), { sequence, properties: [{ id: 'x', before: value, after: value }] });
  }
  const answer = window.result(point(1), true);
  expect(answer.olderEnd).toEqual(point(3));
  expect(answer.changes).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(4 * 1024 * 1024);
});

it('keeps one large edit readable and a filtered empty page advances over the records already examined', () => {
  const window = new HistoryChangeWindow();
  const value = 'x'.repeat(4 * 1024 * 1024);
  window.add(point(2), { value });
  expect(window.result(undefined, false).changes).toEqual([{ value }]);
  expect(new HistoryChangeWindow().result(point(5), false)).toEqual({
    changes: [],
    truncated: true,
    olderEnd: point(5),
  });
});
