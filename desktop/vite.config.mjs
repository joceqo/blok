import { defineConfig } from 'vite';
import { scopeCalendarCss } from './scripts/scope-calendar-css.mjs';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  css: { postcss: { plugins: [scopeCalendarCss] } },
  plugins: [
    tailwindcss(),
    {
      name: 'react-grab-offline-font',
      apply: 'build',
      // The inspector hardcodes a Google Fonts stylesheet in its shadow root.
      // Its existing system font fallback works in the offline desktop bundle.
      transform(code, id) {
        if (id.includes('/react-grab/dist/')) {
          return code.replace(/@import url\("https:\/\/fonts\.googleapis\.com\/[^"]+"\);/g, '');
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@calendarcn-local': fileURLToPath(new URL('./src/calendarcn', import.meta.url)),
      '@blok/page-table': fileURLToPath(new URL('../src/tools/database/page-table.ts', import.meta.url)), '@blok/agent-assistant': fileURLToPath(new URL('../src/shell/agent-assistant.ts', import.meta.url)), '@blok/popover': fileURLToPath(new URL('../src/components/utils/popover/popover-desktop.ts', import.meta.url)), '@blok/modal-dialog': fileURLToPath(new URL('../src/components/utils/modal-dialog.ts', import.meta.url)),
      '@bloklabs/core/full': fileURLToPath(new URL('../src/full.ts', import.meta.url)),
      '@bloklabs/core/view': fileURLToPath(new URL('../src/view/index.ts', import.meta.url)),
      '@bloklabs/core/tools': fileURLToPath(new URL('../src/tools/index.ts', import.meta.url)),
      '@blok/sidebar': fileURLToPath(new URL('../src/shell/sidebar.ts', import.meta.url)),
      '@blok/page-sheet': fileURLToPath(new URL('../src/tools/database/host-page-sheet.ts', import.meta.url)), '@blok/date-editor': fileURLToPath(new URL('../src/tools/database/cells/date-editor.ts', import.meta.url)),
      '@': fileURLToPath(new URL('../', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    proxy: {
      '/api': { target: process.env.BLOK_API_URL || 'http://127.0.0.1:8088', changeOrigin: false, ws: true },
      '/mcp': { target: process.env.BLOK_API_URL || 'http://127.0.0.1:8088', changeOrigin: false },
      '/files': { target: process.env.BLOK_API_URL || 'http://127.0.0.1:8088', changeOrigin: false },
      '/healthz': { target: process.env.BLOK_API_URL || 'http://127.0.0.1:8088', changeOrigin: false },
    },
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
