import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The same rendered templates the Go service embeds, written by
 * scripts/build-email-templates.mjs from the React Email sources in emails/.
 * Both services read one source of truth, so both send the same message.
 */
const directory =
  process.env.BLOK_MAIL_TEMPLATES_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../service/templates');

const marker = /\{\{(\w+)\}\}/g;
/** {{#name}}…{{/name}} wraps a block dropped when the value is empty. */
const section = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\w+\}\}/g;
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };

/** Values are user input: an unescaped one would inject markup into the HTML. */
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (char) => escapes[char]!);

function fill(template: string, values: Record<string, string>, escape: boolean) {
  // The plain-text rendering uppercases headings, markers included, so a
  // {{workspace}} inside one arrives as {{WORKSPACE}}: match names loosely.
  const lookup = (name: string) =>
    Object.entries(values).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '';
  return template
    .replace(section, (_, name: string, inner: string) => (lookup(name) === '' ? '' : inner))
    .replace(marker, (_, name: string) => {
      const value = lookup(name);
      return escape ? escapeHTML(value) : value;
    });
}

export async function mailTemplate(name: string, values: Record<string, string>) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Unknown mail template');
  const [text, html] = await Promise.all(
    ['txt', 'html'].map((extension) =>
      readFile(join(directory, name + '.' + extension), 'utf8').catch(() => {
        throw new Error('Unknown mail template ' + name);
      }),
    ),
  );
  return { text: fill(text!, values, false).trim(), html: fill(html!, values, true) };
}
