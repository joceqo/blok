import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountRemoteAssets } from './remote-assets';
import type { API, BlockAPI } from '../../types';
import { renderPageIcon } from '../../src/shell/page-icon';
const server = 'https://example.org';
const canonical = `${server}/files/image.png`;
const signed = `${canonical}?grant=short-lived`;
const cleanups: Array<()=>void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn)=>fn()); document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('native private media transport', () => {
  it('resolves stored relative custom icons and avatars against the workspace server', async () => {
    const icon = document.createElement('span');
    renderPageIcon(icon, '/files/image.png');
    document.body.append(icon);
    const resolve = vi.fn(async (url: string) => `${url}?grant=short-lived`);
    cleanups.push(mountRemoteAssets(server, resolve));
    const avatar = document.createElement('img');
    avatar.src = '/files/avatar.png';
    document.body.append(avatar);
    await vi.waitFor(() => {
      expect(icon.querySelector('img')?.src).toBe(signed);
      expect(avatar.src).toBe(`${server}/files/avatar.png?grant=short-lived`);
    });
    expect(resolve).toHaveBeenCalledWith(canonical);
  });
  it('signs relative binary downloads without redirecting external or bundled images', async () => {
    const original = vi.spyOn(window, 'fetch').mockResolvedValue(new Response('asset'));
    const resolve = vi.fn(async () => signed);
    cleanups.push(mountRemoteAssets(server, resolve));
    await window.fetch('/files/image.png');
    expect(resolve).toHaveBeenCalledWith(canonical);
    expect(original).toHaveBeenCalledWith(signed, undefined);
    await window.fetch('/assets/logo.png');
    await window.fetch('https://external.org/files/image.png');
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('resolves a new avatar even when the previous image is still being signed', async () => {
    let finish!: (value: string) => void;
    const resolve = vi.fn((url: string) => url === canonical
      ? new Promise<string>((done) => { finish = done; })
      : Promise.resolve(`${url}?grant=next`));
    const avatar = document.createElement('img');
    avatar.src = canonical;
    document.body.append(avatar);
    cleanups.push(mountRemoteAssets(server, resolve));
    avatar.src = `${server}/files/next.png`;
    // Let the observer see the change while the first request is pending.
    await new Promise((done) => setTimeout(done, 0));
    finish(signed);
    await vi.waitFor(() => expect(avatar.src).toBe(`${server}/files/next.png?grant=next`));
  });
  it('renews an expired image grant and bounds retries if the image remains unavailable', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(signed).mockResolvedValue(`${canonical}?grant=renewed`);
    const img = document.createElement('img');
    img.src = '/files/image.png';
    document.body.append(img);
    cleanups.push(mountRemoteAssets(server, resolve));
    await vi.waitFor(() => expect(img.src).toBe(signed));
    img.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(img.src).toBe(`${canonical}?grant=renewed`));
    img.dispatchEvent(new Event('error'));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith(canonical);
  });
  it('renders a signed image while exporting the canonical stored URL', async () => {
    const { ImageTool } = await vi.importActual<{ImageTool: typeof import('@bloklabs/core/tools').Image}>('../../src/tools/image');
    const api = {styles:{block:'blok-block'},media:{reportFailure:vi.fn(),clearFailure:vi.fn()},i18n:{t:(key:string)=>key,has:()=>false}} as unknown as API;
    const block = {id:'image',name:'image',holder:document.createElement('div'),dispatchChange:vi.fn()} as unknown as BlockAPI;
    const image = new ImageTool({data:{url:canonical},config:{},api,block,readOnly:true});
    const root = image.render(); document.body.append(root);
    cleanups.push(mountRemoteAssets(server,async()=>signed));
    await vi.waitFor(()=>expect(root.querySelector('img')?.src).toBe(signed));
    expect(image.save(root).url).toBe(canonical);

  });
  it('signs canonical binary fetches, leaves external fetches untouched and restores transport', async () => {
    const original = vi.fn().mockResolvedValue(new Response('asset'));
    vi.stubGlobal('fetch',original);
    const resolve = vi.fn(async()=>signed);
    const destroy = mountRemoteAssets(server,resolve);
    await window.fetch(canonical);
    expect(original).toHaveBeenCalledWith(signed,undefined);
    await window.fetch('https://external.org/image.png');
    expect(resolve).toHaveBeenCalledTimes(1);
    destroy(); expect(window.fetch).toBe(original);
    vi.unstubAllGlobals();
  });
});
