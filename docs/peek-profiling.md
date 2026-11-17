# Profiling row peeks

Load the page with `?profile=1`, open DevTools Console, and open a row. A `[Blok peek #…]` group appears after five seconds, or when the peek closes or switches rows. The last 20 records are available locally:

```js
copy(JSON.stringify(window.__blokPeekProfiles, null, 2))
```

`copy()` is a Chrome DevTools command. Records contain timings and mode, without page titles, row ids or document content. Nothing is sent to a server. Remove `profile=1` and reload to disable recording. The existing boot sampler also runs with this flag.

Compare a first opening, an immediate reopening of the same row, and a different row. Wait five seconds each time. Repeat three times in a foreground tab with the same collaboration sessions open. Keep `visibility: hidden` runs separate.

| Field | Meaning |
| --- | --- |
| `openSync` | Synchronous `drawer.open()` duration; does not include click handlers before this call. |
| `backdrop`, `promoteDrawer`, `focusTitle`, `isolateBackground` | Work done while opening the shell. |
| `renderRegions`, `mountBody`, `hostEditorCreate` | Properties, body mounting, and host editor construction. `legacyEditorCreate` covers legacy inline editors. |
| `measureTitle`, `measureDock`, `narrowHost` | Geometry work, including any synchronous layout it causes. |
| `shellPaintOpportunity` | Time from opening to a task following an animation frame. This is an approximation, **not a measured paint**. |
| `shellTransitionEnd` | Completion of the shell transition or its existing fallback. |
| `cacheHit` / `cacheMiss` | Actual reuse or creation in the desktop row editor pool. `cachedEditorReady` distinguishes an already initialized cached editor. |
| `editorReady` | Editor initialization completed; this does **not** prove remote synchronization completed. |
| `contentLoading`, `loaderHandoffStart`, `contentInteractive` | Loader shown, hide requested, and handoff completed. The content can be an offline snapshot; these do not certify server freshness. Cached content may have no loader cycle. |
| `inlineBodyAttached` | Existing inline body successfully attached. |
| `longTasks` | Main-thread tasks over 50 ms during the window, when supported. Includes unrelated work and overlapping peeks. |

Spans contain a start offset and duration. Milestones are offsets from the opening, not durations. Spans can nest (`hostEditorCreate` inside `mountBody`, for example): **do not sum them**. A missing milestone means it was not observed within this five-second window, not necessarily failure. Closing stops recording; late promises cannot update closed records. Browser User Timing tracks contain `blok:peek:<number>:<stage>` spans for correlation with a DevTools Performance recording.

Use the result to choose the next change:

- Large `openSync`: reduce shell, focus or top-layer work before adding more preloading.
- Cheap shell but costly cold `hostEditorCreate`: editor reuse and bounded idle preloading may help; check `cacheHit` on reopening.
- Fast constructor followed by a long loading interval: investigate provider/cache/network and document replay with a Performance/Network recording. These timings alone cannot attribute that wait to the backend.
- A long gap between `loaderHandoffStart` and `contentInteractive`: inspect skeleton wait and animation.

Validate any speed gain again without profiling enabled: instrumentation and the boot sampler themselves have a cost.
