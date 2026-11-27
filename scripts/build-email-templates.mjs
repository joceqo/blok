/**
 * Renders the React Email templates in emails/ to static HTML once, so the Go
 * and Node services both send the same message without running React.
 *
 * Values are left as {{name}} markers for the services to substitute. Run
 * after changing a template; the output is committed.
 *
 * Usage: node scripts/build-email-templates.mjs [--check]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { render } from '@react-email/render';

/** Node cannot import .tsx: bundle each template in memory and import that. */
async function load(file) {
  const bundled = await build({
    entryPoints: [file],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
  });
  const code = bundled.outputFiles[0].text;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const source = join(root, 'emails');
const output = join(root, 'apps/service/templates');

const check = process.argv.includes('--check');
const templates = readdirSync(source).filter((name) => name.endsWith('.tsx')).sort();
if (templates.length === 0) throw new Error('no template in emails/');

mkdirSync(output, { recursive: true });
const stale = [];
for (const file of templates) {
  const module = await load(join(source, file));
  const html = await render(module.default(), { pretty: true });
  const text = await render(module.default(), { plainText: true });
  for (const [extension, content] of [['html', html], ['txt', text]]) {
    const target = join(output, basename(file, '.tsx') + '.' + extension);
    const current = (() => { try { return readFileSync(target, 'utf8'); } catch { return null; } })();
    if (current === content) continue;
    if (check) stale.push(target.slice(root.length + 1));
    else writeFileSync(target, content);
  }
}
if (check && stale.length > 0) {
  console.error('Templates out of date, run node scripts/build-email-templates.mjs:\n  ' + stale.join('\n  '));
  process.exit(1);
}
console.log(check ? 'Email templates up to date.' : `Rendered ${templates.length} email template(s) to ${output.slice(root.length + 1)}.`);
