# HTML wireframe quality — single source of truth

This file is the canonical quality bar for HTML wireframes / `<Screen>` /
`WireframeBlock` content, shared word for word by `/visual-plan` and
`/visual-recap` (a condash test pins the two copies identical). Read it in
full before authoring ANY wireframe; do not author wireframes from memory.

**A wireframe is an HTML mockup. The viewer owns the look; you write the
content.** Author `<WireframeBlock id="…"><Screen surface="…" html={"…"} …/></WireframeBlock>`:
a self-contained, semantic HTML fragment plus a `surface`. The condash plan
viewer owns the surface footprint, the light/dark theme, and the element
styling — you never write `<html>`/`<body>`/`<script>`/`<style>` tags or any
width/height/coordinates. You write real HTML layout and real product
content; the viewer themes it.

**Two ways to carry the html.** `html={"…"}` is one JSON-escaped string — fine
for a line or two. For longer markup, prefer the fenced-children form: open the
screen (`<Screen surface="…"> … </Screen>`) and place the fragment in an `html`
code fence, with an optional `css` fence beside it, exactly as `<Diagram>` does.
Fenced children need no newline/quote escaping, so paste real multi-line HTML
and let condash fold it into the screen. Both forms validate identically, and
`condash plans check` warns when a screen carries no html at all.

**Write PLAIN semantic HTML and let the viewer style it.** Bare elements
(`h1`/`h2`/`h3`, `p`, `button`, `input`, `<input type="checkbox">`, `a`,
`hr`, `label`) are auto-themed — no classes needed. Helper classes carry the
rest:

- `.wf-card` / `.wf-box` — a bordered, padded container (a panel, a list item).
- `.wf-pill` / `.wf-chip` — a rounded tag or filter; add `.accent`
  (`<span class="wf-pill accent">`) for the accent-filled variant.
- `.wf-muted` — secondary/muted text (or use `<small>`).
- `button.primary` or any element with `[data-primary]` — the accent-filled
  primary button.

**No decorative shadows around mockups.** No `box-shadow`, `drop-shadow`, or
other fake depth on a frame, root container, or `.wf-card`. Mockups read as
flat, bordered surfaces; use spacing, borders, and labels for separation.

**Use viewer icons, not visible icon words.** For icon-only buttons or
leading icons, write an empty marker such as
`<span data-icon="mail" aria-label="Email"></span>` or `<i data-icon="lock"></i>`.
The viewer replaces it with an inline SVG sized to the surrounding text.
Supported names and aliases: `mail`/`email`, `lock`/`password`, `search`,
`plus`/`add`, `x`/`close`, `check`, `chevronDown`, `chevronUp`,
`chevronLeft`, `chevronRight`, `dots`/`more`, `chevron`/`caret`/`dropdown`
(down chevron), `user`, `settings`, `calendar`, `bell`, `send`, `edit`,
`arrowLeft`, `arrowRight`; unknown names render a neutral dot. Do not put
visible words like "email" or "chevron" where the product would show an icon.

**Use the `--wf-*` tokens for any custom color, never hex.** The viewer maps
these onto the app theme in light and dark, so referencing them is what keeps
a mockup correct in both. For any inline border, background, or text color:
`style="border:1.4px solid var(--wf-line)"`. The tokens are `--wf-ink`
(text), `--wf-muted` (secondary text), `--wf-line` (borders/dividers),
`--wf-paper` (page background), `--wf-card` (container surface),
`--wf-accent` / `--wf-accent-fg` / `--wf-accent-soft` (brand action),
`--wf-warn`, `--wf-ok`, and `--wf-radius`. Never hard-code a hex color and
never set `font-family`.

**Never use host/Tailwind theme classes in wireframe HTML.** Classes such as
`bg-white`, `text-slate-400`, `border-zinc-200`, `shadow-xl`, or arbitrary
color utilities leak foreign CSS assumptions into the mockup and break dark
mode. Use bare semantic elements, `.wf-*` helpers, and `--wf-*` tokens.
Before finishing, scan every `class` and `style` attribute: if a class sets a
color, rewrite it to tokens or remove it. Prefer inline flex/grid styles over
layout classes.

**Use literal CSS lengths for spacing.** The `--wf-*` tokens are colors and
radius only. No guessed spacing tokens (`var(--wf-space-4)`), no Tailwind
spacing classes — if a token does not exist, padding collapses. Use explicit
lengths: `padding:16px`, `gap:12px`, `minmax(0,1fr)`.

**Lay out with inline `style` flex/grid.** You write the real layout —
`display:flex;flex-direction:column;gap:10px;padding:16px` — and the viewer
never repositions anything. Compose the actual product: real labels, real
counts, real dates, real button text grounded in the screen you read; never
lorem or gray bars (except skeletons, below).

**Surface presets — match the real footprint, never default to
desktop+mobile.**

- `browser`: a web page that needs a browser chrome frame.
- `desktop`: a full desktop app page or app shell.
- `mobile`: a phone screen, only when the work is genuinely mobile.
- `popover`: a small floating menu, dropdown, or inline popover.
- `panel`: a side panel, inspector, or sidebar widget.

A sidebar popover renders as a small surface, not a desktop page plus a phone
frame. Do not emit `desktop` + `mobile` variants unless responsive behavior
actually changes the layout.

**Model the actual component shell for small surfaces.** Popovers, dropdown
menus, command palettes use `surface: "popover"` unless page placement is the
point. Dialogs, sheets, inspectors use `panel` / `desktop` as appropriate.
Show the real chrome: title/header row, top-right actions, separators,
fields, selected states, footer actions visible in the workflow. A rendered
UI change belongs in a wireframe; reserve `diagram` for architecture and
data-flow relationships.

**Modify, don't redesign.** When the task changes an existing screen,
reproduce the current screen's real layout FIRST, then change only the delta.
Do not restack the page. For net-new surfaces, compose from the real app
shell — inspect the actual components before drawing: sidebar density,
toolbar actions, overflow menus stay where the product puts them.

**Keep product screens pure.** A product wireframe shows the app state a user
would see. No file contracts, architecture arrows, repo pills, or
implementation callouts inside the screen — put those in prose or a separate
diagram.

**Zoom in on sub-surfaces, don't redraw the page.** For a popover, menu,
dialog, or toast: show the full screen once if placement matters, then a
small separate wireframe whose `html` contains ONLY that sub-surface with the
matching `surface`. Never widen a popover to page width.

**Loading / skeleton states.** Set `skeleton` on the `<Screen>` and fill the
`html` with neutral, textless placeholder geometry — `<div>`s with
`background:var(--wf-line)` and explicit heights/widths, no labels. Never
fake a loader in a `custom-html` block.

**Choose the outer frame deliberately.** `frame: "auto" | "show" | "hide"` —
leave unset for the default drawn frame; `hide` when a tab, column, or the
visual's own chrome already supplies the boundary. Do not use `hide` to
compensate for cramped content; fix the layout.

**Inner padding and borders still matter.** Wrap the fragment in a root
container with real inner padding — at least 14–16px, `box-sizing:border-box`,
`height:100%`, and `gap` between child rows — so the first row never sits
flush against the frame edge. Keep text away from borders everywhere.

**Lay out children safely so they never collide.** Flex/grid with `gap`,
`min-width:0`, sensible overflow. No negative margins, no absolute
positioning, no fixed child widths that collide across themes or zoom.

**Do not wrap intentionally single-line labels.** Toolbars, tab rails,
breadcrumbs, chip rows, file names: `white-space:nowrap` on the row (plus
`overflow:hidden;text-overflow:ellipsis` on labels that can grow) so the
mockup demonstrates the real layout behavior instead of stacked text.

**Fill the frame; keep labels short.** Each surface is a fixed footprint —
compose enough realistic content to fill it with even vertical rhythm; never
leave a large empty band. Sidebars flex to fill (`flex:1`) with persistent
bottom actions after; mobile flows real rows down the whole screen. Shorten
copy rather than letting it wrap.

**Persistent chrome bars span the full frame width.** Top bars, toolbars,
and bottom tab bars are full-width flex rows
(`style="display:flex;align-items:center;width:100%"`) with a flex spacer
(`<div style="flex:1"></div>`) pushing trailing actions to the edge — never
centered content that collapses to its own width. In a Before/After pair the
bar stays full-width in BOTH states; the spacer absorbs the difference.

**Pin bottom bars to the bottom of the frame.** Frame root =
`display:flex;flex-direction:column;height:100%`; the scrolling body gets
`flex:1`; the bar is the LAST child (or `margin-top:auto`), flush at the
bottom rather than floating under the content.

**Before / after must be comparable.** Preserve the unchanged controls in
both states so the reviewer sees exactly what moved; place the new
affordance where the implementation puts it. Same frame size, scale, outer
padding, and density on both sides unless the change itself alters them.

**Name the states with the column label, never inside the frame.** Put the
two states in a `<Columns>` block and set each `<Column label>` to `Before` /
`After` — the viewer draws the label as a heading. Do NOT bake a
Before/After pill or heading into the wireframe `html`.

**Let the surface choose side-by-side vs. stacked.** The columns renderer
lays narrow surfaces (`mobile`, `popover`, `panel`) side by side and
auto-stacks wide surfaces (`desktop`, `browser`) vertically at full width so
a large frame is never crushed into a half column. Author both wireframes
with the real `surface` and the column labels; never hand-stack the pair.

**Never author kit-tree children.** Old documents may carry
`<Screen>` children like `<Row>`, `<Title>`, `<Btn>` — the viewer still
renders them best-effort, but new screens always carry a semantic `html`
fragment. A new kit-tree screen is a defect.

**Good example — a contacts list, surface `browser`.** Real content, helper
classes and tokens only, layout in inline flex:

```html
<div style="display:flex;flex-direction:column;gap:12px;padding:16px;height:100%">
  <div style="display:flex;align-items:center;justify-content:space-between">
    <h1>Contacts</h1>
    <button class="primary">New contact</button>
  </div>
  <div style="display:flex;gap:6px">
    <span class="wf-pill accent">All 128</span>
    <span class="wf-pill">Favorites</span>
    <span class="wf-pill">Archived</span>
  </div>
  <div class="wf-card" style="display:flex;flex-direction:column;gap:0;padding:0">
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1.4px solid var(--wf-line)">
      <div style="width:32px;height:32px;border-radius:999px;background:var(--wf-accent-soft)"></div>
      <div style="flex:1"><strong>Jane Cooper</strong><br /><small>jane@acme.co</small></div>
      <span class="wf-pill">Lead</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px">
      <div style="width:32px;height:32px;border-radius:999px;background:var(--wf-accent-soft)"></div>
      <div style="flex:1"><strong>Marcus Lee</strong><br /><small>marcus@globex.io</small></div>
      <span class="wf-pill">Customer</span>
    </div>
  </div>
</div>
```
