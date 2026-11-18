# Skipping offscreen table rows

Spec for the next change on database table rendering. Written from measurements
taken on the deployed `blok.tousamba.cloud` Sprints page on 2026-11-18, after
the peek-opening work landed (`4125fa2ab`).

## The problem, measured

Opening a row peek costs ~97-133 ms of synchronous main thread, closing it
~55-80 ms. Profiling says that time is **not** spent building the peek. It is
spent in three native operations, each of which triggers a document-wide style
and layout recalculation:

| operation | cost | where |
| --- | --- | --- |
| `showPopover()` (top layer entry) | ~50 ms | `applyMode` → `promoteShell` |
| `focus()` | ~70 ms | title on open, opener on close |
| geometry reads after a style write | ~50-130 ms | fixed in `5b2ac8c6b`, `4125fa2ab` |

The cost is constant whatever row opens, and `showPopover()` on an **empty**
div in the same page costs the same ~50 ms as on the full peek. So the price is
not the element being promoted — it is the size of the document the browser has
to walk.

That document is large:

```
15 071  elements in the page
    94  [data-blok-database-table-row]
    82  elements per row
 7 708  elements in table rows alone  → 51 % of the DOM
```

Notion, measured the same way on a comparable page, opens a peek in **11-21 ms**
and closes in **2-3 ms**, with **zero long tasks**, on a **2 743**-element DOM.
Their peek adds no elements at all (2 744 → 2 743). Scrolling their table to the
bottom leaves the rendered row count unchanged at 40: they page rows in and out.

The conclusion that matters: every micro-optimisation left on the peek fights a
cost that is proportional to the DOM the table builds. Shrink the rendering work
that DOM causes and all three operations above get cheaper at once.

## The decision: CSS containment, not JS virtualization

**Use `content-visibility: auto` on table rows. Do not build a virtualizer.**

Virtualization unmounts offscreen rows. For this codebase that is the wrong
trade:

- **It fights "Everything Is a Block" (CLAUDE.md).** A row is a `database-row`
  block in the block tree. Unmounting rows means the block tree and the DOM stop
  agreeing, and `hierarchy.setBlockParent`, `mountChildBlocks` and `caret.ts` all
  resolve siblings by walking real `holder.parentElement` chains.
- **It breaks find-in-page.** Ctrl+F cannot match text that is not in the DOM.
  `content-visibility: auto` keeps it working — the browser renders a skipped
  subtree when find-in-page matches inside it.
- **It breaks the pointer drag & drop** (`dragManager.ts`), which measures real
  row boxes, and the selection/caret code, which assumes rows exist.
- **It needs a height map, cumulative offsets and binary search** over variable
  row heights, plus scroll-anchoring compensation. Every source found on the
  subject reports scroll jumps as the dominant bug class.

`content-visibility: auto` gives the win without any of that: rows stay in the
DOM and in the block tree, and the browser skips their style, layout and paint
work while they are offscreen.

### Measured gain

A/B in the deployed page, 4 iterations each, one CSS rule injected at runtime:

| | without | with | gain |
| --- | --- | --- | --- |
| peek open (sync) | 139, 132, 118, 135 → **133 ms** | 98, 97, 88, 107 → **97 ms** | **−27 %** |
| peek close (sync) | 77, 64, 76, 80 → **76 ms** | 51, 39, 65, 60 → **55 ms** | **−28 %** |

Two declarations. No JavaScript. The close figures were taken before
`4125fa2ab` was deployed, so the two gains stack.

## The change

Blok's table is **not** a real `<table>`: rows are `display: flex` divs with
`role="row"` / `role="gridcell"`, inside a `display: block` parent. The usual
blocker for this technique — containment conflicting with the automatic table
layout algorithm, which forces `table-layout: fixed` and explicit column widths
— **does not apply here**. Verify this stays true before shipping; if rows ever
become real `<tr>`, this spec needs revisiting.

In `src/styles/database.css`, next to the existing
`[data-blok-database-table-row]` rule (around line 10149):

```css
/* Offscreen rows skip style, layout and paint. The browser still renders one
   when find-in-page matches inside it, so Cmd+F keeps working — which a JS
   virtualizer would have taken away. */
[data-blok-database-table-row] {
  content-visibility: auto;
  contain-intrinsic-size: auto 58px;
}
```

**`auto` in `contain-intrinsic-size` is mandatory, not decorative.** Without it
the browser keeps feeding the scrollbar the guess forever and never corrects it
from real layout, which permanently breaks variable-height rows. With `auto`,
the hint is only used for rows that have never been rendered; afterwards the
last measured size is remembered. Rows in this database measured a 58 px median
with multi-line titles; a row of plain single-line text is shorter. Pick the
median of the real corpus rather than the minimum — the hint only has to be
close enough to keep the scrollbar honest.

If a density setting or a compact row mode changes row height, **re-declare
`contain-intrinsic-size` inside that selector too**. A hint left at the default
height under a mode that stacks cells vertically is the documented way to get
scrollbar drift.

## What to check before calling it done

These are the places where containment can bite in *this* codebase. Each one
needs a look, and the ones marked (test) need a test.

1. **Sticky elements.** `database.css` has five `position: sticky` rules. A
   sticky element **inside** a contained subtree sticks to that subtree, not the
   scrollport. Confirm none of them is a descendant of
   `[data-blok-database-table-row]` — the sticky header lives above rows, which
   is why the current structure survives, but check the row gutter and the
   selection bar. (test)

2. **Scroll-to-row.** `database-table-view.ts` resolves rows for scrolling
   (`scrollIntoView`, the `anchor` lookup around line 2316). Until a far-off row
   has been rendered once, its position comes from the hint, so a scroll to a
   distant row can land short and then settle. Verify "open a row, close it,
   the table returns to the same scroll offset" still holds. (test)

3. **Drag & drop.** `dragManager.ts` is pointer-based and measures row boxes.
   Boxes still exist under `content-visibility: auto` — the hint gives every row
   a height — but a drag that scrolls far during the gesture crosses rows whose
   height is still estimated. Test a drag from the top of a long table to the
   bottom. (test)

4. **`prepareVisibleRows`** (`database-table-view.ts`, around line 777) uses
   IntersectionObserver on rows. Containment does not change intersection
   behaviour, but confirm the prefetch still fires for the rows a person can
   actually see, and still stops at two.

5. **The deferred-render handshake.** `scheduleDeferredDescendants`
   (`src/components/utils/deferred-render.ts`) already wakes row bodies in
   batches. These two mechanisms are orthogonal — one skips rendering work for
   offscreen rows, the other staggers tool wake-up — but a row that is both
   skipped and deferred must still wake correctly when it scrolls in. (test)

6. **Playwright selection-paint matrix.** `content-visibility` affects paint.
   `test/playwright/tests/ui/selection-paint-matrix.spec.ts` asserts exactly one
   tint per selected block, light and dark, for every tool inside every
   container. Run it — a contained row that paints its `::after` halo
   differently would show up there.

7. **Nested databases.** A row body can contain another database with its own
   rows, so the selector matches rows inside peeks too. That is desirable, but
   check that a nested table inside an open peek is not skipped while visible.

## What NOT to do

- **Do not apply it to the header row, the selection bar, or the "New" row.**
  They are always on screen; containment there buys nothing and risks layout.
- **Do not use a bare length** (`contain-intrinsic-size: 58px`). See above.
- **Do not add `content-visibility: hidden`** anywhere as a "stronger" version.
  It never renders, breaks find-in-page, and is not what this is.
- **Do not start unmounting rows** as a follow-up because the gain looked good.
  The block-tree invariants above are not negotiable without a separate design.
- **Do not raise heap or worker limits** to run the checks (CLAUDE.md). ESLint
  and `tsc` currently exhaust the default V8 heap in a cold-cache worktree; say
  so rather than working around it.

## Validation

- Scoped unit tests for the behaviours marked (test) above, written **before**
  the change and watched failing where they describe a regression.
- `test/unit/styles/` already snapshots CSS rules
  (`main-css-rules.snap.txt`); the new declarations will move that golden file.
  Update it deliberately, and check the CSS byte-budget test still passes.
- Re-run the peek profile on the deployed page with `?profile=1`, three
  openings, comparing `openSync` against the 97 ms figure above. The diagnostics
  in `docs/peek-profiling.md` give the method; note its own warning that
  instrumentation has a cost, so confirm any gain again with profiling off.
- Report the DOM element count before and after on the same page. The count
  should **not** drop — that is the point. What drops is the work it causes.

## Afterwards

With rows contained, the remaining peek costs are one `showPopover` (~50 ms
today, less once the document is cheaper to walk) and the post-paint body
mount (`inlineRenderBatch`, 155-194 ms on the inline path — a single atomic
block exceeding the 8 ms batch budget, most likely the nested "Tâches"
database). Measure again before touching either: this change moves both.

## Sources

- [Chrome — Defer rendering heavy content](https://developer.chrome.com/docs/modern-web-guidance/guides/performance/defer-rendering-heavy-content)
- [content-visibility vs. virtualization, 50k-card benchmark](https://agustinbarrientos.com/writing/senior-eye/content-visibility-vs-virtualization)
- [Web Standards — Making a long list fast](https://web-standards.dev/news/2026/08/content-visibility-vs-virtualization/)
- [Virtualizing data-heavy tables without breaking UX](https://www.alikaraki.me/blog/virtualizing-data-heavy-tables)
- [Notion — How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
- [Notion databases deep dive](https://www.resumelens.org/blog/notion/notion-databases-deep-dive)
