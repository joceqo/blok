/**
 * Generates `packages/server/node/src/blob/content-types.ts` — ASP.NET's
 * FileExtensionContentTypeProvider table — from
 * `test/unit/server-conformance/fixtures/content-types.json`.
 *
 * WHY THIS EXISTS: the Node host serves stored files, and the C# host's
 * Content-Type for a key is whatever that provider says. Transcribing 382
 * entries by hand rots; the Go host generates its own copy the same way
 * (`packages/server/go/blokserver/contenttypes.go`, kept honest by
 * `contenttypes_test.go`). Node's `contentTypeFor` used to answer four
 * extensions and `application/octet-stream` for everything else, so a stored
 * `.ivf` came back as a byte stream instead of `video/x-ivf`.
 *
 * Run it whenever the fixture changes:
 *   node scripts/generate-node-content-types.mjs
 *
 * `packages/server/node/src/blob/content-types.fast.test.ts` fails until the
 * generated table matches the fixture, so drift cannot ship silently.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(REPO_ROOT, 'test/unit/server-conformance/fixtures/content-types.json');
const TARGET = join(REPO_ROOT, 'packages/server/node/src/blob/content-types.ts');

const table = JSON.parse(readFileSync(SOURCE, 'utf8'));
const entries = Object.entries(table).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

const lines = entries.map(([extension, type]) => `  ${JSON.stringify(extension)}: ${JSON.stringify(type)},`);

writeFileSync(TARGET, `// Code generated from test/unit/server-conformance/fixtures/content-types.json; DO NOT EDIT.
// Regenerate with: node scripts/generate-node-content-types.mjs

/**
 * ASP.NET's FileExtensionContentTypeProvider table, in its own spelling —
 * which has upper-case keys such as ".IVF". Look an extension up through
 * \`contentTypeFor\`, never here: the lookup folds case.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
${lines.join('\n')}
};
`);

console.log(`Wrote ${entries.length} content types to ${TARGET}`);
