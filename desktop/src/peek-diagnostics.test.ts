// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountPeekDiagnostics } from './peek-diagnostics';
let dispose: (() => void) | undefined;
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks(); });
it('keeps a bounded local history of close causes and press surfaces without field content', () => {
  dispose = mountPeekDiagnostics();
  const drawer = document.createElement('div');
  drawer.setAttribute('data-blok-database-drawer', '');
  const input = document.createElement('input');
  input.setAttribute('data-blok-database-drawer-prop-value', '');
  input.value = 'private value';
  drawer.append(input); document.body.append(drawer);
  input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
  input.remove();
  for (let i=0; i<25; i++) document.dispatchEvent(new CustomEvent('blok:peek-close', {detail:{reason:'outside-press',mode:'side',stack:'test caller'}}));
  const raw = localStorage.getItem('blok:peek-dismissals') ?? '';
  const records = JSON.parse(raw);
  expect(records).toHaveLength(20);
  expect(records[19]).toMatchObject({reason:'outside-press',mode:'side',press:{surface:'property',inside:true,connected:false}});
  expect(raw).not.toContain('private value');
});
it('never interrupts close when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw Error('unavailable');});
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('unavailable');});
  dispose = mountPeekDiagnostics();
  expect(()=>document.dispatchEvent(new CustomEvent('blok:peek-close',{detail:{reason:'programmatic',mode:'side'}}))).not.toThrow();
});
