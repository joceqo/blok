import { describe, expect, it } from 'vitest';
import { validCalendarResponse } from './calendar-response.ts';

describe('calendar responses', () => {
  it('accepts the three answers an invitee can give', () => {
    for (const value of ['accepted', 'declined', 'tentative']) {
      expect(validCalendarResponse(value), value).toBe(value);
    }
  });

  it('accepts taking an answer back', () => {
    expect(validCalendarResponse('needs-action')).toBe('needs-action');
  });

  it('refuses anything else rather than storing it', () => {
    // The column has a CHECK, but a refusal here answers 400 instead of 500.
    for (const value of ['yes', '', 'ACCEPTED', 'accepted; drop', null, undefined, 42, {}]) {
      expect(validCalendarResponse(value), String(value)).toBeUndefined();
    }
  });
});
