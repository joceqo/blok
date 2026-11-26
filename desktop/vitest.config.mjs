import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

<<<<<<< HEAD
export default defineConfig({
  resolve: { alias: {
      '@calendarcn-local': fileURLToPath(new URL('./src/calendarcn', import.meta.url)), '@bloklabs/core/view': fileURLToPath(new URL('../src/view/index.ts', import.meta.url)), '@': fileURLToPath(new URL('../', import.meta.url)), '@blok/page-table': fileURLToPath(new URL('../src/tools/database/page-table.ts', import.meta.url)), '@blok/agent-assistant': fileURLToPath(new URL('../src/shell/agent-assistant.ts', import.meta.url)), '@blok/popover': fileURLToPath(new URL('../src/components/utils/popover/popover-desktop.ts', import.meta.url)), '@blok/modal-dialog': fileURLToPath(new URL('../src/components/utils/modal-dialog.ts', import.meta.url)), '@blok/page-sheet': fileURLToPath(new URL('../src/tools/database/host-page-sheet.ts', import.meta.url)), '@blok/date-editor': fileURLToPath(new URL('../src/tools/database/cells/date-editor.ts', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
||||||| f8ef3c6b39
=======
export default defineConfig({
  resolve: { alias: { '@blok/date-editor': fileURLToPath(new URL('../src/tools/database/cells/date-editor.ts', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
>>>>>>> origin/feat/desktop-title-date-mentions
