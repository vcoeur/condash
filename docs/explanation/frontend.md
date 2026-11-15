---
title: Frontend pitfalls · condash explanation
description: The renderer invariants that were learned the hard way — stacking contexts, Solid reactivity, sanitisation, screenshot capture, and the tree walks behind the panes. Aimed at contributors changing the renderer.
---

# Frontend pitfalls

> **Audience.** Contributors changing anything under `src/renderer/` (and the main-process walks that feed it). Each section is a rule that a real defect produced, with the failure kept in view so the next person recognises it.

## Pane cards compose shared primitives — and a pane grid class can die silently when the DOM moves to a shared component (v4.98.0)

Since v4.98.0 every card pane (Code, Knowledge, Resources, Skills, Tasks, Logs, Deliverables) composes the shared primitives in `src/renderer/primitives.css` — `.card` (silhouette: fill / border / radius / shadow / hover), `.card-grid` (auto-fill columns keyed on `--card-min` / `--card-gap`), `.status-pill`, `.file-glyph`, `.pane-empty`, `.card-reveal` — with pane identity (stripes, tints, density, cursor) staying on the pane class. The Projects `.row` deliberately keeps its family-framed hero chrome and only adopts the grid. When adding or restyling a pane, compose these instead of hand-rolling chrome, and delete the duplicated declarations rather than overriding them back (primitives.css bundles before pane CSS, so equal-specificity pane rules win).

**Gotcha — the wiring from a `cardMinWidth.*` setting to actual columns has three hops, and the middle one can silently die.** The setting lands as a `--card-min-<pane>` var (`src/renderer/hooks/use-card-min-width.ts`), a pane-root rule maps it to `--card-min`, and `.card-grid` consumes it. Before v4.98.0 the knowledge/resources/skills "grid" classes (`.knowledge-grid` etc.) declared full grid rules but **matched no DOM node at all** — those panes had long since moved their file cards into the shared `TreeView`'s `.tree-files` (a single-column flex) — so three `cardMinWidth.*` settings were settings-UI-visible yet inert, and knip can't flag dead *CSS*. The fix routes the vars through the pane roots (`.knowledge-pane` / `.resources-pane` / `.skills-pane`) down to `.tree-files.card-grid`. **Rule: when a pane's cards migrate into a shared component, grep the pane's CSS for classes that no longer match any TSX — and treat a "setting with no visible effect" report as a possible dead-selector, not a settings bug.**

Related: `.card` carries `contain: layout paint`, which clips in-card absolute descendants — safe today only because every in-card dropdown/popover Portals to `document.body` (see the stacking-context section below). A new in-card overlay must Portal too.

## In-app file viewers + reveal in file manager (v4.26.0)

condash previews more file types **inside** the app instead of shelling out, and every card representing an on-disk thing can reveal it in the OS file manager.

- **One classifier.** `src/shared/file-category.ts` (`categorise` / `mimeFor`, node-free) is the single extension→category map, shared by the main-process resources walk (`src/main/resources.ts` re-exports it) and the renderer's file-open router (`src/renderer/deliverable-open.ts`'s `openDeliverableTarget`). `ResourceCategory` gained an **`html`** bucket (split out of `text`). Before v4.26.0 the Resources pane (category-driven) and the deliverable/tree path (`endsWith`-driven) classified independently and could disagree.
- **Viewers**, all keyed off the classifier: `pdf`→PDF modal, `html`→HTML modal (rendered `condash-file://` webview **+ a Rendered/Source header toggle**, source = highlighted markup), `image`→new image modal (raster + SVG, fit-to-window), `markdown`/`text`→note modal read-only — and text/code is now **syntax-highlighted** (`src/renderer/markdown.ts`'s `highlightCode`, language-by-extension, degrading to escaped plain text for unknown langs or files > 200 KB). Audio/video/archive/binary stay external (`shell.openPath`).
- **`condash-file://` is conception-bounded** (`src/main/index.ts`), so the HTML + image viewers only resolve files inside the active conception; one outside 404s and the viewer's open-in-OS button is the fallback. Same constraint the PDF (`pdfToFileUrl`) and markdown-image paths already had.
- **Reveal in file manager** = new `showInFolder` IPC → `shell.showItemInFolder` (`src/main/ipc/system.ts`), surfaced on Resources cards, Logs (sessions + task runs), local-file Deliverables rows, and the pdf/html/image viewer headers. The Code pane already exposed "Open in file manager" per worktree (`code-parts/branch-actions.tsx` → `onOpen` → `shell.openPath` on the dir).

**Gotcha — the `openExternal` IPC rejects local paths.** `openExternal` only allows `http(s)`/`mailto` (`src/main/ipc/system.ts`: `if (!/^(https?|mailto):/i.test(target)) throw`), so handing it a local file path **silently no-ops** (the rejected promise is `void`-ed). A local-file "open externally" must call **`openPath`** (→ `shell.openPath`, OS default app). The HTML modal carried this latent bug until v4.26.0 (its `onOpenExternally` was wired to `openExternal`); the PDF modal had it right via `onOpenInOs`→`openPath`.

## Mermaid diagrams must render off an untransformed ancestor (v4.34.4)

The markdown viewer renders `mermaid` blocks client-side. **`mermaid.run({ nodes })`
measures each node's htmlLabel via `getBoundingClientRect` inside the passed node
— and `getBoundingClientRect` returns *screen-space* (post-CSS-`transform`)
geometry.** So if any ancestor carries a CSS `transform` at measure time, every
node box is sized to the transformed text width, not the real one. condash mounts
mermaid from a `createEffect` that fires while the note/help modal's `modal-in`
`scale(0.97) → scale(1)` open animation is still live (`modal-base.css`), so boxes
came out too narrow and clipped their labels once the animation settled to
`scale(1)` (issue [#319](https://github.com/vcoeur/condash/issues/319)). It was
**not** a font-metrics problem — mermaid labels use mermaid's own
`"trebuchet ms", verdana, arial, sans-serif` themeCSS stack (its id-scoped
`<style>` outranks `.md-rendered .mermaid` on specificity), not the page's
Figtree, and boxes size correctly even with a cold web font — so
`document.fonts.ready` would not have helped.

**Fix:** render each block with `mermaid.render(id, source)` (no container arg) and
inject the returned SVG, instead of `mermaid.run`. With no container mermaid builds
its measurement DOM in a throwaway element on `<body>` (it does `select("body")`),
which has no transform, so widths are correct regardless of any ancestor transform
or animation (`src/renderer/markdown.ts`, `runMermaidIn`). **Lesson: never let
mermaid measure inside a transformed/animating subtree — measurement that relies on
`getBoundingClientRect` inherits every ancestor `transform`.** Quantified repro: box
width tracks the ancestor scale under `run` (260 → 254 at `scale(0.97)` → 180 at
`scale(0.6)`) but holds at 260 under `render` at every scale.

## Cache-invalidating IPC must not tear down its own popup

A popup that reads from a cache-invalidating IPC must not be torn down by a background invalidation. Surfaced 2026-04-30 on the dirty-badge popover — every chokidar burst rebuilt the Code tab, which closed the popover under the user's cursor mid-inspection. The 2.0.13 revert (`0c36e2b`) rolled back the auto-refresh portion; manual click-to-inspect remains.

A future iteration of "live Code tab" needs either (a) freeze the popover against background invalidations while it's open, or (b) drive refresh from focus + explicit user actions only, not chokidar bursts. Same rule applies to the Settings modal, Notes modal, knowledge tree popovers, and any other in-renderer overlay that reads from `getDirtyDetails`, `listProjects`, `readKnowledgeTree`, or any other cache-invalidated verb.

## A `backdrop-filter` / `transform` chrome ancestor traps a fixed popover's z-index — Portal it (v4.84.0)

`backdrop-filter` (like `transform` and `filter`) on an ancestor creates a **new stacking context** *and* makes that ancestor the **containing block** for `position: fixed` descendants. A popover rendered inline under such an ancestor has its `z-index` scoped **inside** the ancestor's stacking context, so it can never paint above sibling content that outranks the ancestor — no matter how high the `z-index`.

Instance: `.status-bar` carries `backdrop-filter: blur(16px)` for its frosted chrome (`src/renderer/app-shell.css`). The Recent-commits popover (`.status-commits`, `src/renderer/status-bar-indicators.tsx`) rendered inline inside the bar, so its `z-index: 60` was trapped there and it painted **behind** the Code-pane repo cards in `.workspace` — even though the cards carry no positive z-index of their own. (Positioning looked right only because the bar sits at the viewport origin, masking that `top/left` had become bar-relative.)

Fix: wrap the popover in Solid's `<Portal>` (`import { Portal } from 'solid-js/web'`) so it renders under `document.body`, escaping the ancestor's stacking context and containing block; `z-index` then competes at the body level and `position: fixed` is viewport-relative again. **This is the third condash popover portalled for exactly this reason** — `action-dropdown-button.tsx` and `branch-actions.tsx` already do it, their docstrings naming it the "menu hides under neighbouring cards" fix (`src/renderer/panes/code-parts/branch-actions.tsx`: *"rendered as a `position: fixed` overlay anchored to the trigger to escape the parent's stacking context"*). **Rule: any popover/menu placed inside chrome that carries `backdrop-filter` / `transform` / `filter` (the status bar, an animating modal, a transformed card) must Portal to `document.body` — never rely on `z-index` alone.** Related overlay gotcha: [Cache-invalidating IPC must not tear down its own popup](#cache-invalidating-ipc-must-not-tear-down-its-own-popup).

A `tests/status-bar-indicators.spec.ts` assertion locks that the open popover has no `.status-bar` ancestor.

## SolidJS `<For>` over a memo derived from a coarse signal recreates rows (drops input focus)

A `<For each={listMemo()}>` keys rows by **array-item reference identity** and tears down a row's DOM when its item reference changes. If `listMemo` is derived from a *coarse* signal — one that also changes for reasons unrelated to the list — and its producer allocates fresh objects each run, every unrelated update gives `<For>` new item references and it recreates every row. When the rows contain `<input>`s, the focused input is destroyed and rebuilt, so **typing drops focus after one character**.

Surfaced 2026-05-31 in the Tasks **Run** fill view: `markers`/`textMarkers` read the whole `props.fill()` signal, but each keystroke replaces the entire `FillState` object (`setField` spreads a new one), so the memos re-ran and `extractMarkers` (`src/shared/tasks.ts`: `seen.set(key, { key, default })` — new objects each call) handed `<For>` a fresh array every keystroke (`src/renderer/panes/tasks.tsx`: `const markers = createMemo(() => extractMarkers(props.fill().def.prompt))`).

Fix the *class*: derive list memos from the **narrowest** input, via an intermediate memo whose identity-stable (`===`) output gates downstream recomputation. `createMemo` only propagates when its return value changes by `===`, so `const prompt = createMemo(() => props.fill().def.prompt); const markers = createMemo(() => extractMarkers(prompt()))` stops re-running on unrelated `FillState` edits, keeping the array referentially stable and the input DOM in place. (`<Index>` also preserves nodes by position, but the defect is the over-coupled memo, not the choice of primitive.) Reproduce/guard by typing **character-by-character** — Playwright `pressSequentially`, not `fill()` (which sets the value atomically and masks the bug).

Regression E2E in `tests/tasks.spec.ts` ("keeps focus") types a multi-char value char-by-char and fails on the pre-fix build (fixed in PR [#289](https://github.com/vcoeur/condash/pull/289), v4.19.4).

## A bespoke Esc branch over the shared `Modal` shell needs `stopImmediatePropagation` (v4.100.0)

The shared `Modal` shell (`src/renderer/modal.tsx`) installs its **own** capture-phase Esc listener on `document` via `useModalEscHandler` (`src/renderer/modal-helpers.ts`), calling `props.onClose()`. A modal that layers its own Esc handling on top — a confirm gate, a find bar, any intermediate state Esc should back out of first — registers a **second** listener on that **same** node. `stopPropagation` stops propagation to other *nodes*; it never stops a sibling listener on the same node. Only **`stopImmediatePropagation`** does.

Instance: the MDX viewer's unsaved-answers gate (`src/renderer/mdx-modal.tsx`). Esc against the gate set `pendingClose` false and called `stopPropagation`; the shell's listener then ran in the same event, called `onClose` → `requestClose`, found the answer drafts still dirty, and re-raised the gate. Net effect inside one keystroke: nothing moved, and Esc read as a dead key. `stopImmediatePropagation` is also the *order-independent* fix — if the bespoke handler registers first the shell's never fires; if the shell's fires first its close request is a no-op against an already-raised gate, and the bespoke one then dismisses it.

**Rule: any Esc branch layered on the shared shell must `stopImmediatePropagation`, never `stopPropagation`.** The note and settings modals don't hit this because they opt out of the shell entirely and own their layout (the shell's own docstring names them as the "richer Esc contract" exceptions). The same trap applies to any other key the shell ever claims. Related: a document-level `keydown` in a modal is also unguarded against *stacked* modals — condash's Ctrl+S handlers (note modal, MDX viewer) all fire together when both are mounted, since none tests for being topmost.

**A second `Modal` shell stacked on the first (v4.113.0):** when a child overlay is itself a `Modal` — the svg-block lightbox (`src/renderer/mdx-modal-parts/svg-lightbox.tsx`) over the MDX viewer — both shells hold a `document` capture Esc listener and the outer one registered first, so one Esc would close the note under the lightbox. `stopImmediatePropagation` in the inner shell is too late (same node, later registration). The inner overlay listens on **`window`** in the capture phase instead — `window` capture runs before any `document` listener — and stops the event there. It is portalled to `document.body` (after `#root`, all backdrops share one z-index) so it paints above every `#root` overlay, which is why owning Esc unconditionally while mounted matches what the reader sees; a "topmost by DOM order" test would be wrong for exactly that reason.

Regression assertion in `tests/mdx-viewer.spec.ts` (Esc against the gate → gate gone, modal open, pending answer intact) fails on the pre-fix build and passes after (PR [#477](https://github.com/vcoeur/condash/pull/477), v4.100.0). Stacked-shell e2e in `tests/mdx-svg-block.spec.ts` (Esc closes only the lightbox) for v4.113.0 (PR [#531](https://github.com/vcoeur/condash/pull/531)).

## Only a **markdown image token** gets a local `src` — a raw `<img>` in an author's HTML is dropped silently

An image in a note or `.mdx` block resolves against the note's directory **only when markdown-it parses it as an `image` token**. The rewrite lives in exactly one renderer rule, which resolves a relative `src` to `condash-file:///<abs>` (`src/renderer/markdown.ts:70-84`: `md.renderer.rules.image = …  if (isRelativeAssetPath(src)) token.attrs[srcIdx][1] = relativeToCondashFile(baseDir, src)`).

A raw `<img src="foo.jpg">` typed into an HTML-bearing block is an `html_block` / `html_inline` token, so it **never reaches that rule** and keeps its relative `src`. The renderer's CSP then kills it — `img-src 'self' data: condash-file:` (`src/renderer/index.html:14`) — and Chromium falls back to alt text with nothing logged. DOMPurify is not the culprit and will not warn: sanitization deliberately leaves external loads to the CSP (`src/renderer/mdx-modal-parts/sanitize.ts:6-8`: *"External resource loads are already dead at the CSP layer"*).

**Rule: use markdown image syntax for every asset in a note or a visual block; never a hand-written `<img>`.** Two corollaries, both cheap:

- **Keep asset filenames ASCII.** An accented name has to survive markdown-it's `src` parsing *and* the per-segment URI encoding in `relativeToCondashFile` intact; ASCII sidesteps the question rather than testing it.
- **Prefer one composed montage over many tiles** when a block shows a set of images — one markdown token instead of N, and it renders identically in the viewer and in a PDF export (whose export CSP is `img-src condash-file: data:`, `src/renderer/note-modal-parts/export-pdf.ts:38`).

The failure is silent by construction — a dropped image looks like an authoring typo, not a policy block — so it costs a rebuild-and-stare cycle every time it is rediscovered.

## A `?inline` stylesheet is minified in the production bundle — never match it by line shape (v4.113.0)

The visual-note PDF export (`src/renderer/mdx-modal-parts/export-pdf.ts`) inlines the app's light design tokens into the print document by lifting the first top-level `:root { … }` block out of `styles.css?inline`. The first cut matched `:root {` at a line start. Every unit test passed — they read the unminified source file — and the exported PDF came out with the `Diagram` panels unbordered and untinted: in the Vite production bundle the `?inline` string is **one minified line** (`@font-face{…}…:root{…}`), the match returned `''`, every `--wf-*` token resolved to nothing, and `printToPDF` printed it without complaint. Found only by running the built app and rendering the PDF. **Rules:** (1) anything that reads a `?inline` asset must work on the minified shape — the extractor is now a depth-tracking scanner, and the test carries a minified fixture next to the source-file one; (2) an export that falls back silently to "unstyled" is the worse failure — `exportStylesheet()` throws when no tokens are found, so the head shows an error instead of a PDF that looks like success.

`extractRootTokens` + `exportStylesheet` live in `src/renderer/mdx-modal-parts/export-pdf.ts`, with the minified fixture in `export-pdf.test.ts` (v4.113.0, PR [#531](https://github.com/vcoeur/condash/pull/531)).

## An svg block's external references: one rule over every attribute, not a list of attribute names (v4.113.0)

The `svg` block's sanitizer (`sanitizeSvg`, its own DOMPurify instance in `src/renderer/mdx-modal-parts/sanitize.ts`) must produce markup that is safe to **download as a standalone file**, not only to draw under the app's CSP. Three review rounds showed why an enumerated policy cannot hold: round 1 scrubbed the css fence; round 2 added `href` / `xlink:href` / `style`; round 3 found `fill="url(https://…)"`, `filter`, `mask`, `clip-path`, `marker-*` all admitted by DOMPurify's profile, a CSS ident escape (`u\72l(`) walking around the `url(` regex in `style`, and a quoted fragment `url('#g')` misclassified as external by a backtracking regex. The fix that held (the third-round design change, per the "three rounds on one component" rule) is **one predicate on every attribute value, whatever the attribute's name**: `attributeReachesOutside` — a `url(` whose argument (quotes and whitespace allowed) is not a `#fragment`, or any backslash at all (SVG attributes never need one) — drops the attribute; `href`/`xlink:href` must be `#…` or `data:image/…`. What it strips beyond that is the single `SVG_STRIPPED_ELEMENTS` list in `src/shared/plan-blocks/svg-markup.ts`, which `condash mdx check` warns from, and `svgRootTag` there is the one root-tag scanner for both sides (quote-aware; a DOCTYPE ends at the first `>` exactly as the HTML parser reads it, so an internal subset is a check **error**, not something the viewer breaks on silently). The standalone file additionally writes the css fence with `<`/`&` as CSS escapes and backslashes doubled, so `</style>` cannot close the element and an escape cannot spell `url(`.

Unit tests in `sanitize.test.ts` / `parse-mdx.test.ts`; e2e `tests/mdx-svg-block.spec.ts` carries a tracker image, an external paint server, a quoted fragment and an `xlink:href` (v4.113.0, PR [#531](https://github.com/vcoeur/condash/pull/531)).

## Screenshot regeneration: isolate a UI change's pixel deltas with old-vs-new CSS runs — the capture env does not byte-reproduce committed shots (v4.116.0)

The committed PNGs under `docs/assets/screenshots/` come from a rendering environment that does **not** byte-reproduce locally: on this machine, 11 of the 17 slugs in the set at the time (it holds 19 today) differ from the committed versions even at unchanged CSS. A regeneration after a CSS change therefore produces PNGs that differ from committed for two superimposed reasons — the change itself and environment drift — and committing a whole regen sweep bundles unrelated visual churn into the PR. To isolate the CSS-caused delta, run `npm run test -- --reporter=list screenshots.spec.ts` **twice**: once with the new CSS and once with the old (`git stash` the CSS change, rebuild — the Playwright runner does **not** rebuild — capture, then unstash). Slugs that are byte-identical between the two runs did not render a changed element; commit only the slugs where the two runs differ. Slugs that differ from committed but are byte-identical old-vs-new CSS are pre-existing capture staleness and stay out of the commit (observed: `item-fuzzy-search`, `plan-document`, `projects-done`). The runner rebuilds nothing, so a stash-based comparison against a stale build silently compares the old CSS twice.

## The card's left edge carries only the family frame — link state lives on the Linked-tabs fold (v4.117.0)

The Projects card's left edge is reserved for the **family frame**: a solid 6px spine for a parent, a dashed 6px edge for a subproject, the neutral frame for a standalone card (v4.116.0, PR #545). Decoration of the manual card ↔ terminal-tab link must **never** draw on that edge — a linked family card would show two left bars. Since v4.117.0 (PR #546) the link state is signalled on the card by the **Linked-tabs fold** in the relations zone: `.row .linked-tabs-banner` with a `.linked-tabs-toggle` header (caret + "Linked tabs" + count, collapsed by default, persisted per card under `links.<slug>` in the same localStorage collapse map as the Subprojects fold). The header is accent-tinted with a **full-width accent underline** — the border-width is a constant 3px in both strengths so the expanded rows never shift; the subtle/strong pair is carried by underline saturation (55% accent mix for linked-any, solid for linked-active) plus an accent-filled count pill in the strong state. `.linked-any` / `.linked-active` are the semantic row hooks for that distinction. Two earlier presentations were tried and rejected: an always-visible bottom "Linked tabs" block (too tall — every linked card grew a full row list) and a meta-row chip pill opening a portaled popover (visual review rejected the pill UX, and the popover rows duplicated the chip's count). **Do not re-propose either** — if the fold ever needs to change, extend it. The tab side stays undecorated: a tab's linked projects appear only in its hover popover and context menu.

## A spawned terminal tab is not addressable yet — name the tab, don't wait for it (v4.120.0)

`spawnUserShell` resolves as soon as **main** has the pty, but the renderer reaches the tab one reconcile pass later, and that pass is not atomic: it inserts the tab into `tabs()` **before** awaiting `mountForSession`'s dynamic xterm import, and calls `setActiveIn` only **after** it (`src/renderer/terminal-pane/controller.ts`). Two consequences bite every call site that spawns a tab and then acts on it. `typeIntoActive` resolves `activeIdIn(activeColumn())` and returns early when there is none, so text typed too soon is **silently dropped** — no toast, no console error, and the tab looks fine. And a link written for the new sid is deleted by any `pruneLinks` still in flight over a pre-spawn snapshot, because that pass prunes against a roster which by construction cannot contain the id.

Neither "sleep a bit" nor "poll until the tab is active" is the answer. A flat settle is a hope — a cold app's first dynamic import outlasts `AGENT_SPAWN_SETTLE_MS` (350 ms). Polling for *active* can never arrive, because activation is last-writer-wins within a pass and a tab inserted in the same tick takes it. Two rounds were also spent trying to make the controller **protect** the premature link, via `pendingSpawnIntent` — that map's entries are consumed in exactly one place and leak whenever the restart path inserts the replacement before writing the intent, so exempting it from `pruneLinks` made restarted tabs permanently prune-proof (phantom links surviving every reload).

The shipped answer is `focusSpawnedTab` (`src/renderer/terminal-bridge.ts`): poll the **monotone** condition — roster membership via `sessionLabel(sid) !== null` — then call `switchTo('my', sid)` to make the tab active outright, and **return whether that succeeded** so the caller declines to type when it did not. `switchTo` no-ops on an id the roster does not hold, which is what makes the membership-first ordering load-bearing. Stop observing a state the renderer will reach on its own; address the tab you mean, and report when you cannot. Two sibling call sites still carry the old shape — `runShellCommand` (**Install skills**) and `handlePasteToTerm` (Resources → **Paste path → Term**) — and remain open work.

## A tree walk that readdirs an unfiltered dirent rejects the whole read on a FIFO (v4.133.5)

The Resources pane painted its "No resources directory yet" empty state on a conception whose `resources/` directory was full: two FIFOs (agedum test leftovers) sat under `resources/local/`, and `readResourcesTree`'s walk accepted **every** non-hidden dirent ("every file is surfaced regardless of extension"), then did `stat` → `isFile()`? no → treat as directory → `readdir` — which throws `ENOTDIR` on a FIFO. Nothing caught it, the rejection crossed the IPC, and the renderer tree store keeps last-good (null on first fetch), so the pane showed the wrong empty state with no error anywhere.

The sibling readers were never exposed: `knowledge.ts` and `skills.ts` filter dirents to `isDirectory() || isFile()` (+ `.md`) before walking, so a FIFO dirent is dropped up front. Why resources specifically: `resources/local/` is the gitignored agent-scratch area where test runs leave arbitrary artifacts — **the one conception tree where non-file entries actually occur**. Since v4.133.5 (PR #597) the resources walk filters dirents to `isFile() || isDirectory() || isSymbolicLink()` (symlinks kept so link→file/dir keep resolving, unlike the `.md`-only siblings) **and** contains each child's walk in its own try/catch — one unreadable entry (broken symlink, raced delete, EACCES subtree) drops alone with a scoped `console.warn` instead of rejecting the tree. **Rule: any condash tree walk must classify dirents by type before stat/readdir, and per-child failure containment is the difference between a missing entry and a blank pane.** The pane still cannot distinguish "walk failed" from "directory missing" — a possible follow-up, not yet built.

Regressions in `src/main/resources.test.ts`.
