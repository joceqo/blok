import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../',import.meta.url));
const {version} = JSON.parse(await readFile(new URL('../packages/mcp/package.json',import.meta.url),'utf8'));
await build({
  absWorkingDir:root, entryPoints:{'mcp-runtime':'apps/service-node/mcp/runtime.ts','markdown-runtime':'apps/service-node/markdown/runtime.ts'},
  outdir:'apps/service-node/dist/shell',outExtension:{'.js':'.mjs'},
  bundle:true, platform:'node',target:'node22',format:'esm',mainFields:['module','main'],loader:{'.txt':'text'},
  define:{VERSION:JSON.stringify(version)},external:['bufferutil','utf-8-validate'],
  banner:{js:"import {createRequire as nodeRequire} from 'node:module'; const require = nodeRequire(import.meta.url);"},
});
