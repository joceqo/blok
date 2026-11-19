# Typing beside a database

Use the complete desktop workspace for this investigation. An isolated editor
with the same blocks can miss the problem: the desktop canvas, wide table
scrollports and surrounding shell participate in layout.

## Reproduce locally

From the repository root:

```sh
BLOK_PROFILE_TYPING=1 python3 scripts/low-memory.py desktop-test src/typing-profile.browser.test.ts
```

This creates two disposable, local workspaces with 200 sidebar entries: an empty
paragraph, then a paragraph beside a grouped database with 140 rows. It types ten
characters with 100 ms between keys. It does not connect to the service or modify
any remote page. The diagnostic is skipped in ordinary test runs.

To test an existing document, supply an editor `OutputData` JSON export (`blocks`
with `id`, `type`, `data`, `parent` and `content`), containing a root paragraph:

```sh
BLOK_PROFILE_TYPING=1 BLOK_TYPING_CASE=document \
BLOK_TYPING_DOCUMENT=/absolute/path/document.json \
BLOK_TYPING_OUTPUT=/tmp/blok-typing-after \
python3 scripts/low-memory.py desktop-test src/typing-profile.browser.test.ts
```

The export is copied into a fresh browser context's local storage. Collaboration,
network traffic and remote persistence are deliberately absent from this local
reproduction. Treat exported data and traces as private; do not commit them.

For each case, the output directory (system temporary directory by default)
receives `blok-typing-<case>.json`, `.cpuprofile` and `.trace.json`:

- JSON: ten keydown-to-second-animation-frame delays, DOM node and table row counts.
- CPU profile: load into Chrome DevTools' JavaScript profiler.
- Trace: load into the Performance panel; inspect Layout, UpdateLayoutTree and
  their callers, including native work not attributed to a JavaScript function.

The double-frame measurement is a paint opportunity, not a guarantee that pixels
have reached the display. Profiling adds overhead. Compare the same fixture,
browser and instrumentation; repeat with profiling disabled on the deployed app.
Do not infer multi-second typing stalls are fixed from a ten-key local sample.

## A/B an injected style

`BLOK_TYPING_STYLE` injects CSS only into the disposable fixture. For example, to
compare against the previous uncontained rows after the containment change:

```sh
BLOK_PROFILE_TYPING=1 BLOK_TYPING_CASE=document \
BLOK_TYPING_DOCUMENT=/absolute/path/document.json \
BLOK_TYPING_OUTPUT=/tmp/blok-typing-before \
BLOK_TYPING_STYLE='[data-blok-database-table-row] { content-visibility: visible; }' \
python3 scripts/low-memory.py desktop-test src/typing-profile.browser.test.ts
```

Run checks serially with the wrapper. Never compare different documents or one
instrumented run against an uninstrumented one.

## Findings, 2026-11-19

The initial full-workspace reproduction of the Commits document (167 blocks,
140 database rows) produced a 93.6 ms median double-frame delay, 113.1 ms maximum,
and 867.8 ms of Layout over ten keys. The isolated editor was much faster.
Few DOM mutations did **not** mean little rendering work: a small edit repeatedly
caused layout to visit the surrounding large table. Native work dominated the
trace even though it appeared as `(program)` in the CPU profile.

A first injected row-containment experiment reduced these figures to 30.1 ms
median, 40.2 ms maximum and 175.7 ms of Layout. Wrapper-only `contain: layout` did
not improve the result. These are local diagnostic measurements, not production
latency guarantees.

The final paired run, including protection for the gutter, measured:

| Ten-key local run | Containment disabled | Final CSS |
| --- | ---: | ---: |
| Median double-frame delay | 87.1 ms | 37.5 ms |
| Maximum | 105.0 ms | 43.9 ms |
| Total Layout | 885.0 ms | 437.3 ms |
| Table rows in the DOM | 140 | 140 |

The DOM contained about 14,000 nodes in both cases. The improvement comes from
less layout work, not from deleting row elements.

The CPU profile also found an avoidable deep DOM equality check in
`BlockManager.setCurrentBlockByChildNode`. Editor ownership now compares node
identity: structurally identical editor trees are not the same editor instance.

CSS containment must preserve the row's left gutter and frozen columns. Native
`content-visibility: auto` retains the row elements and lets the browser skip
irrelevant offscreen work; it does not unload blocks or change saved data.
Engines that do not support an expandable paint clip retain the previous
rendering path. In the tested WebKit build this gate is closed; the measured
containment gain applies to Chrome, not to the macOS app. A registered internal
length resolves the themed gutter before use: Chrome rejects a `calc()` directly
in `overflow-clip-margin`.

See [MDN's content-visibility reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)
and the [paint containment definition](https://www.w3.org/TR/css-contain-2/#paint-containment).

Validation of this change: 140 BlockManager tests and 9 browser regressions
(containment in Chrome/WebKit, sticky/frozen headers, comment badges and Load
more) pass; the desktop TypeScript check and production web build pass. The CSS
equivalence gate already failed on HEAD. Accounting only for the two new rules
and their 1,082 authored bytes leaves exactly the same baseline failures: 169
snapshot diff lines and a 7,181-byte budget overage. Those unrelated differences
were not accepted into the golden snapshot.
