import { describe, it, expect, vi, afterEach } from 'vitest';
import type { API, BlockTool, BlockToolConstructorOptions } from '../../../../types';
import type { CodeData } from '../../../../types/tools/code';

const DIAGRAM = '<svg width="100%" viewBox="0 0 240 180" style="max-width: 240px;"><rect/></svg>';

vi.mock('../../../../src/shared/katex', () => ({
  renderLatex: vi.fn().mockResolvedValue('<span class="katex">rendered</span>'),
}));
vi.mock('../../../../src/tools/code/mermaid-loader', () => ({
  renderMermaid: vi.fn().mockResolvedValue(DIAGRAM),
}));
vi.mock('../../../../src/tools/code/language-detector', () => ({
  detectLanguage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../src/tools/code/prism-loader', () => ({
  tokenizePrism: vi.fn().mockResolvedValue(null),
  isHighlightable: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../src/tools/code/prism-applier', () => ({
  applyPrismHighlight: vi.fn().mockReturnValue(() => {}),
  disposePrismStyles: vi.fn(),
}));

const api = (): API => ({
  styles: {
    block: 'ce-block', inlineToolbar: '', inlineToolButton: '', inlineToolButtonActive: '',
    settingsButton: '', settingsButtonActive: '', selected: '',
  },
  // openLightbox asks `has` before `t`: the real I18nInstance carries both.
  i18n: { t: (key: string) => key, has: () => false },
  blocks: { getCurrentBlockIndex: vi.fn().mockReturnValue(0), insert: vi.fn() },
}) as unknown as API;

const options = (language: string): BlockToolConstructorOptions<CodeData> => ({
  data: { code: 'flowchart LR\n A --> B', language },
  config: {},
  api: api(),
  readOnly: true,
  block: { id: 'code-block-id' } as never,
});

/** Mounts the tool read-only, where a previewable language renders the drawing alone. */
async function mountPreview(language: string): Promise<HTMLElement> {
  const { CodeTool } = await import('../../../../src/tools/code');
  const tool: BlockTool = new CodeTool(options(language));
  const el = tool.render();
  if (!(el instanceof HTMLElement)) throw new Error('render() must return an element');
  document.body.appendChild(el);
  tool.rendered?.();
  // renderPreview resolves on a microtask chain, after the loader promise.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const preview = el.querySelector<HTMLElement>('[data-blok-testid="code-preview"]');
  if (!preview) throw new Error('preview container missing');
  return preview;
}

const lightbox = (): Element | null => document.querySelector('.blok-image-lightbox');

describe('opening a diagram full size', () => {
  afterEach(() => {
    document.querySelectorAll('.blok-image-lightbox').forEach((el) => el.remove());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('opens the image lightbox on a double-click, so the drawing can be zoomed', async () => {
    const preview = await mountPreview('mermaid');
    expect(preview.querySelector('svg')).not.toBeNull();
    expect(lightbox()).toBeNull();

    preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const opened = lightbox();
    expect(opened).not.toBeNull();
    const img = opened?.querySelector('img');
    expect(img?.getAttribute('src')).toContain('data:image/svg+xml');
    // The size the lightbox needs to scale the drawing, taken from the viewBox.
    expect(decodeURIComponent(img?.getAttribute('src') ?? '')).toContain('width="240"');
  });

  it('stays closed for a language whose preview is not a drawing', async () => {
    const preview = await mountPreview('latex');

    preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(lightbox()).toBeNull();
  });
});
