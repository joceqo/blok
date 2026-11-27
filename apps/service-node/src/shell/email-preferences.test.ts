import { describe, expect, it, vi } from 'vitest';
import { emailPreferenceRows, emailPreferenceWrite, type EmailPreferences } from './email-preferences.ts';

describe('e-mail preference rows', () => {
  it('reads every setting as off when the member has no row', () => {
    // No row means nobody asked: the reader must not invent a yes.
    expect(emailPreferenceRows(undefined)).toEqual({
      activity: false, always: false, pageUpdates: false, digest: false,
    });
  });

  it('maps the stored columns onto the setting names', () => {
    expect(emailPreferenceRows({ activity: true, always: false, page_updates: true, digest: false }))
      .toEqual({ activity: true, always: false, pageUpdates: true, digest: false });
  });

  it('keeps an unknown setting out of a write', () => {
    const { columns, values } = emailPreferenceWrite({ activity: true, nonsense: true } as unknown as Partial<EmailPreferences>);
    expect(columns).toEqual(['activity']);
    expect(values).toEqual([true]);
  });

  it('coerces a non-boolean into a refusal rather than a yes', () => {
    // A malformed body must never turn mail on.
    const { values } = emailPreferenceWrite({ activity: 'yes' } as unknown as Partial<EmailPreferences>);
    expect(values).toEqual([false]);
  });
});
