# `svg` blocks — inline SVG diagrams

Read before authoring ANY `<Svg>` block. The block is a hand-authored SVG
diagram living **inside the `.mdx`** — no sidecar file, no image export, no
render-to-PNG loop. condash sanitizes it, draws it on a light card in both
themes, opens it full-size in a lightbox on click, and offers **Download .svg**
(a standalone file with the block's CSS embedded and every token resolved).

## Shape

````mdx
### Sync pipeline

<Svg caption="One sweep: classify, settle, commit, regenerate." alt="Four boxes left to right joined by arrows">

```svg
<svg viewBox="0 0 1200 320" width="1200" height="320" role="img">
  <defs>
    <marker id="arrow" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="7"
            refX="10" refY="3.5" orient="auto">
      <path d="M0 0L10 3.5L0 7z" fill="var(--wf-muted)"/>
    </marker>
  </defs>
  <rect x="40" y="100" width="220" height="80" rx="10"
        fill="var(--wf-accent-soft)" stroke="var(--wf-accent)" stroke-width="1.5"/>
  <text x="150" y="146" text-anchor="middle" class="t">git status → classify</text>
  <line x1="260" y1="140" x2="330" y2="140" stroke="var(--wf-muted)" stroke-width="1.5"
        marker-end="url(#arrow)"/>
</svg>
```

```css
.t { font-size: 14px; font-weight: 600; fill: var(--wf-ink); }
.sub { font-size: 11.5px; fill: var(--wf-muted); }
```

</Svg>
````

- `<Svg>` children: one ```svg fence holding the whole `<svg …>…</svg>`, and
  an optional ```css fence for the classes its `<text>` (or shapes) use. The
  viewer scopes that CSS to the block — it cannot restyle the page.
- Props: `caption` (shown under the card), `alt` (always set — one line saying
  what the diagram shows; it labels the card for assistive tech and names the
  lightbox).
- Block heading: a `###` in the prose above, never a `title` prop.
- **Inline only.** No `src`, no `notes/NN-<slug>/x.svg`, no `![]()` image —
  the diagram is part of the note and travels with it.

## What condash does with it

- **Sanitizes** with an SVG-only allow-list. Stripped (and `condash mdx check`
  warns on each before you open the viewer): `<style>` (document-scoped — put
  class rules in the ```css fence instead), `<script>`, `<foreignObject>`,
  `<use>`, `<animate>`, `<animateMotion>`, `<animateTransform>`, `<set>`;
  anchors are neutralised. Every external reference is dropped at the same
  time — an `href` / `xlink:href` that is not `#fragment` or `data:image/…`,
  a `style` attribute with a non-fragment `url()` — so neither the card nor
  the downloaded file loads anything from outside.
- **Draws it on a light card** in light *and* dark theme. Inside the card the
  `--wf-*` tokens are pinned to the light palette, so a token-coloured diagram
  reads everywhere; a literal-coloured one reads too, because the ground is
  always white.
- **Sizes it** `max-width: 100%` of the card — the root needs a `viewBox` to
  scale (check warns without one). Give `width`/`height` too so the natural
  size is known.
- **Lightbox** on click: Fit / 1:1, **Copy SVG**, **Download .svg**. The saved
  file is the sanitized markup with `xmlns`, the ```css fence embedded as a
  `<style>` child, and `var(--wf-*)` replaced by the light literals — it opens
  standalone in any viewer.
- **PDF export** keeps it vector.

## Verification — no PNG step

1. `condash mdx check <note>.mdx` — green, and read every warning (no
   `viewBox`, no `alt`, an element the viewer strips).
2. Open the note once in condash. Look at the diagram as drawn: text inside
   boxes, arrows landing on edges, nothing struck through, nothing
   overlapping. Click it to check the lightbox. That is the render check;
   there is no image to generate.

## Design rules (the quality bar)

Adapted from the `/svg-diagram-designer` skill's layout and collision rules,
without its render-verify loop and file hand-off.

- **Plan the canvas first.** Size it to content (a typical architecture map is
  1200–1600 × 600–1000 user units; `viewBox="0 0 W H"` with matching
  `width`/`height`). Lay out in horizontal **bands**: title band ~50, rows of
  66–100 for boxes, 40–50 gaps for arrows and labels. Align boxes to invisible
  columns with uniform gaps (60 is a good default). 40 minimum outer margin.
- **Trim.** A good diagram fits one canvas: detail goes into short side notes
  or the prose, not more boxes. One idea per diagram — two ideas are two
  blocks.
- **Estimate text width** as `font-size × 0.52 × characters` (0.6 for bold).
  Every line fits its box minus 20 padding each side; shorten the words rather
  than shrink below 10.5. Centre box text with `text-anchor="middle"` on the
  box centreline; left-align card body text with a 24 inset. Line spacing
  inside a box: 16; first baseline = box top + 20 for a title line.
- **Arrows.** `<marker markerUnits="userSpaceOnUse">` — always; the default
  multiplies the head by the stroke width. Head length ≈ 10, width ≈ 3.5 ×
  stroke, ratio ≈ 1.5:1. Every connector's terminal segment ≥ head + 6, or the
  head swallows the line (and on a polyline floats off the elbow). Arrows start
  and end **on box edges**, never inside a box or across text; route around
  section labels.
- **Labels beside arrows, not on them** — offset ≥ 15 perpendicular from the
  midpoint, clear of container borders. Section headers (uppercase row titles)
  sit in gaps between arrows.
- **Colour = tokens.** `--wf-ink` (text), `--wf-muted` (secondary text,
  arrows), `--wf-line` (borders), `--wf-paper` / `--wf-card` (fills),
  `--wf-accent` / `--wf-accent-soft` (the thing the diagram is about),
  `--wf-warn`, `--wf-ok`. Never `font-family`; a derived/secondary state is the
  same fill with a dashed stroke (`stroke-dasharray="5 4"`); containers are
  `--wf-card` fill with a dashed `--wf-line` stroke.
- **Typography** through the ```css fence: title 22/700 · box title 14/700 ·
  box subtitle 11.5 · section header 11/700 uppercase, letter-spacing 1.5 ·
  flow labels 10.5 italic. Define classes once, reuse them.
- **No external resources** — no `<image href="http…">`, no web fonts, no
  non-fragment `url()` in the CSS; the sanitizer drops them and the standalone
  file scrubs the CSS ones. `url(#marker)` / `url(#gradient)` are fine.

## When not to use an `svg` block

- Panels, layers, swimlanes, matrices whose **text must reflow** — that is the
  html/css `diagram` block with the `.diagram-*` primitives.
- A screen or UI state — a `wireframe`.
- A standalone deliverable (a presentation figure, a file to send) — author it
  with `/svg-diagram-designer` as its own `.svg`, outside the note.
