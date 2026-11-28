import { describe, expect, it } from 'vitest';
import { mailTemplate } from './mail-template.ts';

describe('mail templates', () => {
  it('substitutes, escapes the HTML part and leaves no marker', async () => {
    const { text, html } = await mailTemplate('login-code', {
      code: '123456',
      publicURL: 'https://blok.test/<a>',
    });
    for (const [name, body] of Object.entries({ text, html })) {
      expect(body, `${name} lost the code`).toContain('123456');
      expect(body, `${name} still carries a marker`).not.toContain('{{');
    }
    // An unescaped value would let a crafted workspace name inject markup.
    expect(html).toContain('&lt;a&gt;');
    expect(html).not.toContain('/<a>');
    expect(text).toContain('/<a>');
  });

  it('drops an optional section when its value is missing', async () => {
    const values = { workspace: 'Acme', publicURL: 'https://blok.test' };
    const with_ = await mailTemplate('invitation', { ...values, message: 'À bientôt' });
    expect(with_.text).toContain('À bientôt');
    expect(with_.html).toContain('À bientôt');
    const without = await mailTemplate('invitation', values);
    for (const [name, body] of Object.entries(without)) {
      // A lone "Message de l'administrateur" above nothing reads as broken.
      expect(body, `${name} kept the note heading`).not.toContain('Message de l');
      expect(body, `${name} still carries a marker`).not.toContain('{{');
      expect(body, `${name} lost the workspace name`).toContain('Acme');
    }
  });

  it('rejects an unknown template', async () => {
    await expect(mailTemplate('does-not-exist', {})).rejects.toThrow();
  });

  it('renders the same parts the Go service embeds', async () => {
    const { text } = await mailTemplate('login-code', { code: 'X', publicURL: 'Y' });
    expect(text).toContain('Saisissez ce code pour vous connecter');
  });
});
