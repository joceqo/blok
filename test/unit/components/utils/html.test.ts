import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  stripFakeBackgroundElements,
  moveElementBefore,
  moveElementAfter,
  moveElementToEnd,
  withBatchedMoves,
} from '../../../../src/components/utils/html';

describe('html', () => {
  describe('stripFakeBackgroundElements', () => {
    it('should return empty string as-is', () => {
      expect(stripFakeBackgroundElements('')).toBe('');
    });

    it('should return HTML without fake background markers unchanged', () => {
      const html = '<p>Hello <strong>world</strong></p>';
      expect(stripFakeBackgroundElements(html)).toBe(html);
    });

    it('should unwrap the slash-menu pill, keeping the typed query', () => {
      const html = 'Hello&nbsp;<span data-blok-slash-search="Type to search">/he</span>';

      expect(stripFakeBackgroundElements(html)).toBe('Hello&nbsp;/he');
    });

    it('should strip single fake background element', () => {
      const html = '<p>Hello <span data-blok-fake-background="true">world</span></p>';
      const expected = '<p>Hello world</p>';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should strip multiple fake background elements', () => {
      const html = '<p><span data-blok-fake-background="true">Hello</span> <span data-blok-fake-background="true">world</span></p>';
      const expected = '<p>Hello world</p>';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should preserve nested content within fake background', () => {
      const html = '<p><span data-blok-fake-background="true"><strong>Hello</strong> world</span></p>';
      const expected = '<p><strong>Hello</strong> world</p>';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should handle fake background with complex nesting', () => {
      const html = '<div><span data-blok-fake-background="true"><em>text</em><span>nested</span></span></div>';
      const expected = '<div><em>text</em><span>nested</span></div>';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should handle fake background at the start', () => {
      const html = '<span data-blok-fake-background="true">Start</span> of text';
      const expected = 'Start of text';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should handle fake background at the end', () => {
      const html = 'End of <span data-blok-fake-background="true">text</span>';
      const expected = 'End of text';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should handle consecutive fake backgrounds', () => {
      const html = '<span data-blok-fake-background="true">A</span><span data-blok-fake-background="true">B</span><span data-blok-fake-background="true">C</span>';
      const expected = 'ABC';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should preserve other data-blok attributes', () => {
      const html = '<p data-blok-selected="true">text</p>';
      expect(stripFakeBackgroundElements(html)).toBe(html);
    });

    it('should handle false value for data-blok-fake-background', () => {
      const html = '<span data-blok-fake-background="false">text</span>';
      expect(stripFakeBackgroundElements(html)).toBe(html);
    });

    it('should handle mixed content with fake backgrounds', () => {
      const html = '<p>Before <span data-blok-fake-background="true">highlighted</span> after</p>';
      const expected = '<p>Before highlighted after</p>';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should handle empty fake background element', () => {
      const html = '<p>Text<span data-blok-fake-background="true"></span>more</p>';
      const expected = '<p>Textmore</p>';
      expect(stripFakeBackgroundElements(html)).toBe(expected);
    });

    it('should return null or undefined as-is', () => {
      expect(stripFakeBackgroundElements(null as unknown as string)).toBe(null);
      expect(stripFakeBackgroundElements(undefined as unknown as string)).toBe(undefined);
    });
  });

  describe('stateful element moves', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      // Drop any moveBefore polyfill a test installed.
      delete (Element.prototype as unknown as { moveBefore?: unknown }).moveBefore;
    });

    const setup = (): { parent: HTMLElement; a: HTMLElement; b: HTMLElement; c: HTMLElement } => {
      const parent = document.createElement('div');
      const [a, b, c] = ['a', 'b', 'c'].map((id) => {
        const el = document.createElement('div');

        el.id = id;

        return el;
      });

      parent.append(a, b, c);
      document.body.appendChild(parent);

      return { parent, a, b, c };
    };

    const order = (parent: HTMLElement): string =>
      Array.from(parent.children).map((el) => el.id).join('');

    it('moveElementBefore places the node just before the reference', () => {
      const { parent, a, c } = setup();

      moveElementBefore(c, a);

      expect(order(parent)).toBe('cab');
    });

    it('moveElementAfter places the node just after the reference', () => {
      const { parent, a, c } = setup();

      moveElementAfter(a, c);

      expect(order(parent)).toBe('bca');
    });

    it('moveElementToEnd appends the node to the parent', () => {
      const { parent, a } = setup();

      moveElementToEnd(parent, a);

      expect(order(parent)).toBe('bca');
    });

    it('uses the native state-preserving moveBefore when available', () => {
      const moveBefore = vi.fn(function (this: Element, node: Node, ref: Node | null) {
        this.insertBefore(node, ref);
      });

      (Element.prototype as unknown as { moveBefore: typeof moveBefore }).moveBefore = moveBefore;

      const { parent, a, c } = setup();

      moveElementBefore(c, a);

      expect(moveBefore).toHaveBeenCalledOnce();
      expect(order(parent)).toBe('cab');
    });

    it('falls back to insertBefore when moveBefore throws', () => {
      const moveBefore = vi.fn(() => {
        throw new Error('cross-document move');
      });

      (Element.prototype as unknown as { moveBefore: typeof moveBefore }).moveBefore = moveBefore;

      const { parent, a, c } = setup();

      moveElementBefore(c, a);

      expect(moveBefore).toHaveBeenCalledOnce();
      expect(order(parent)).toBe('cab');
    });

    // Notion U113: a redo moves a block after its caret is restored; the caret must survive the move.
    it('keeps a selection that sits inside the moved node', () => {
      const { parent, a, c } = setup();
      const text = document.createTextNode('three');

      c.appendChild(text);
      window.getSelection()?.setBaseAndExtent(text, 5, text, 5);

      moveElementBefore(c, a);

      const selection = window.getSelection();

      expect(order(parent)).toBe('cab');
      expect([selection?.anchorNode, selection?.anchorOffset, selection?.focusOffset]).toEqual([text, 5, 5]);
    });

    it('leaves a selection outside the moved node alone', () => {
      const { a, b, c } = setup();
      const text = document.createTextNode('two');

      b.appendChild(text);
      window.getSelection()?.setBaseAndExtent(text, 1, text, 3);

      moveElementBefore(c, a);

      const selection = window.getSelection();

      expect([selection?.anchorNode, selection?.anchorOffset, selection?.focusOffset]).toEqual([text, 1, 3]);
    });

    // Chrome forces a whole-page style and layout on every selection read while
    // nothing is selected; a table mount moves 1200 detached cell holders.
    it('does not read the selection when the moved node is detached', () => {
      const parent = document.createElement('div');
      const node = document.createElement('div');
      const getSelection = vi.spyOn(window, 'getSelection');

      moveElementToEnd(parent, node);

      expect(getSelection).not.toHaveBeenCalled();
      expect(node.parentNode).toBe(parent);
    });

    it('does not force a selection read while moving connected loading content', () => {
      const root = document.createElement('div');
      root.setAttribute('inert', '');
      const node = document.createElement('div');
      const target = document.createElement('div');
      root.append(node, target);
      document.body.append(root);
      const getSelection = vi.spyOn(window, 'getSelection');

      moveElementToEnd(target, node);

      expect(getSelection).not.toHaveBeenCalled();
      expect(node.parentNode).toBe(target);
    });

    // The profile blames selectionInside for 26.8 s of a 46 s load, but the
    // function has three exits and the profile cannot tell them apart: the
    // loading redactor is meant to be [inert], which should already skip the
    // costly read. These counters say which exit actually runs.
    describe('selection probe', () => {
      afterEach(() => {
        delete (globalThis as { __blokSelectionProbe?: unknown }).__blokSelectionProbe;
      });

      const probe = (): Record<string, number> => {
        const counters = { detached: 0, inert: 0, read: 0 };

        (globalThis as { __blokSelectionProbe?: unknown }).__blokSelectionProbe = counters;

        return counters;
      };

      it('counts a move of a detached node as detached', () => {
        const counters = probe();

        moveElementToEnd(document.createElement('div'), document.createElement('div'));

        expect(counters).toMatchObject({ detached: 1, inert: 0, read: 0 });
      });

      it('counts a move inside loading content as inert', () => {
        const root = document.createElement('div');
        const node = document.createElement('div');
        const target = document.createElement('div');

        root.setAttribute('inert', '');
        root.append(node, target);
        document.body.append(root);
        const counters = probe();

        moveElementToEnd(target, node);

        expect(counters).toMatchObject({ detached: 0, inert: 1, read: 0 });
      });

      it('counts a move in live content as a selection read', () => {
        const { parent, a } = setup();
        const counters = probe();

        moveElementToEnd(parent, a);

        expect(counters).toMatchObject({ detached: 0, inert: 0, read: 1 });
      });

      it('stays silent when no probe is installed', () => {
        const { parent, a } = setup();

        expect(() => moveElementToEnd(parent, a)).not.toThrow();
      });
    });

    // Mounting a document moves one holder per nested child, and each move read
    // the live selection right after a DOM write: 862 reads at ~31 ms of forced
    // layout each, 26.7 s of a 46 s load. Inside a batch the anchor is read once
    // and `node.contains` answers the rest for free.
    describe('withBatchedMoves', () => {
      it('reads the selection once however many nodes move', () => {
        const { parent, a, b, c } = setup();
        const getSelection = vi.spyOn(window, 'getSelection');

        withBatchedMoves(() => {
          moveElementToEnd(parent, a);
          moveElementToEnd(parent, b);
          moveElementToEnd(parent, c);
        });

        expect(getSelection.mock.calls.length).toBeLessThanOrEqual(1);
        expect(order(parent)).toBe('abc');
      });

      it('still keeps a caret that sits inside a moved node', () => {
        const { parent, a, c } = setup();
        const text = document.createTextNode('three');

        c.appendChild(text);
        window.getSelection()?.setBaseAndExtent(text, 5, text, 5);

        withBatchedMoves(() => { moveElementBefore(c, a); });

        const selection = window.getSelection();

        expect(order(parent)).toBe('cab');
        expect([selection?.anchorNode, selection?.anchorOffset]).toEqual([text, 5]);
      });

      it('leaves a selection outside the moved nodes alone', () => {
        const { a, b, c } = setup();
        const text = document.createTextNode('two');

        b.appendChild(text);
        window.getSelection()?.setBaseAndExtent(text, 1, text, 3);

        withBatchedMoves(() => { moveElementBefore(c, a); });

        const selection = window.getSelection();

        expect([selection?.anchorNode, selection?.anchorOffset, selection?.focusOffset]).toEqual([text, 1, 3]);
      });

      it('counts one selection read per batch, not one per move', () => {
        const { parent, a, b, c } = setup();
        const counters = { detached: 0, inert: 0, read: 0, batched: 0 };

        (globalThis as { __blokSelectionProbe?: unknown }).__blokSelectionProbe = counters;

        withBatchedMoves(() => {
          moveElementToEnd(parent, a);
          moveElementToEnd(parent, b);
          moveElementToEnd(parent, c);
        });

        delete (globalThis as { __blokSelectionProbe?: unknown }).__blokSelectionProbe;

        // `read` must track the live reads, wherever they happen. Counting the
        // exit of selectionInside instead reported read: 0 while every batch
        // still read once — a counter that measured beside the thing it named.
        expect(counters.read).toBe(1);
        expect(counters.batched).toBe(3);
      });

      it('returns what the batch returned', () => {
        expect(withBatchedMoves(() => 'fini')).toBe('fini');
      });

      it('reads the selection again on the next batch', () => {
        const { parent, a, b } = setup();

        withBatchedMoves(() => { moveElementToEnd(parent, a); });
        const getSelection = vi.spyOn(window, 'getSelection');
        withBatchedMoves(() => { moveElementToEnd(parent, b); });

        expect(getSelection).toHaveBeenCalled();
      });

      it('restores batching even when the batch throws', () => {
        const { parent, a } = setup();

        expect(() => withBatchedMoves(() => { throw new Error('boom'); })).toThrow('boom');

        const getSelection = vi.spyOn(window, 'getSelection');

        moveElementToEnd(parent, a);

        expect(getSelection).toHaveBeenCalled();
      });
    });

    it('is a no-op when the reference is the node itself', () => {
      const moveBefore = vi.fn();

      (Element.prototype as unknown as { moveBefore: typeof moveBefore }).moveBefore = moveBefore;

      const { parent, a } = setup();

      moveElementBefore(a, a);

      expect(moveBefore).not.toHaveBeenCalled();
      expect(order(parent)).toBe('abc');
    });
  });
});
