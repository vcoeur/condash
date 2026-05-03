---
title: Deliverables and PDFs · condash guide
description: The `## Deliverables` section syntax, filename conventions, PDF generation, the in-app PDF viewer, and how to override it.
---

# Deliverables and PDFs

> **Audience.** Daily user.

**When to read this.** Your item produces a tangible output — a report, a design doc, an incident post-mortem — and you want it to show up on the card with a download link and an embedded viewer.

Deliverables are a first-class concept: a `## Deliverables` section in a README lists one or more PDF files, and condash renders a download badge on the card plus a viewer in the expanded card.

## The `## Deliverables` section

Add to your README:

```markdown
## Deliverables

- [Plugin API proposal — current draft](deliverables/plugin-api-proposal.pdf) — Distributed to the team for review, 2026-04-15.
- [Appendix A: risks](deliverables/plugin-api-proposal-appendix-a.pdf)
```

Per line:

```markdown
- [<label>](<path>.pdf) — <optional description>
```

- **Label** — text shown on the card and in the viewer header.
- **Path** — relative to the item's directory. Must end in `.pdf`.
- **Description** (optional, after ` — `) — a one-line note shown under the label.

Multiple deliverables per item are fine; each renders as its own row in the Deliverables section of the item modal.

## Filename convention

Place PDFs under `<item>/deliverables/`. The directory exists for exactly this: to separate generated outputs from editable notes. condash scans the filesystem lazily, so the directory only needs to exist when at least one deliverable is linked.

Slug the filename to match the item: `<item-slug>.pdf` for the primary deliverable, `<item-slug>-<suffix>.pdf` for secondary ones. This keeps them discoverable in bare `ls` listings without peeking inside each item.

## What the modal looks like

![An item modal with a Deliverables section and a PDF entry](../assets/screenshots/item-document-with-pdf-light.png#only-light)
![An item modal with a Deliverables section and a PDF entry](../assets/screenshots/item-document-with-pdf-dark.png#only-dark)

- Open the item modal (click the card). Below the body, the **Deliverables** section lists every entry with its label, description, and resolved path.
- Click a row to open the PDF in an embedded viewer modal.
- The viewer's header has an **↗ Open in OS default viewer** button (`shell.openPath`, so whichever app your OS associates with `.pdf`) and an **× Close** button.

The embedded viewer is an Electron `<webview>` pointed at a `file://` URL — Chrome's built-in PDF rendering does the work. No bundled pdf.js, no external dependency, works offline.

## Generating the PDF

condash doesn't generate PDFs — you do, from whatever source lives alongside the item. The common shape:

- Write the body as Markdown under `<item>/notes/<name>.md`.
- Convert with `~/.claude/scripts/md_to_pdf.sh` (pandoc + xelatex + mermaid-filter):

```bash
cd <conception_path>/projects/2026-04/2026-04-08-plugin-api-proposal
bash ~/.claude/scripts/md_to_pdf.sh notes/draft.md deliverables/plugin-api-proposal.pdf
```

The script handles heading-level shifts, section numbering, Mermaid diagrams, and French accents. See the global `CLAUDE.md` in your home directory for the full recipe.

Refresh the dashboard; the PDF badge lights up and the viewer picks up the file. No extra registration step.

## Opening PDFs in your OS viewer

Click **↗** in the embedded viewer's header. condash hands the file to `shell.openPath()`, which uses whatever app your OS has registered for `.pdf` (Evince / Okular on Linux, Preview on macOS, the bundled Reader / Acrobat on Windows). On Linux you can change that default through `xdg-mime default`; condash itself does no path resolution.

> **Note.** `configuration.json` accepts a `pdf_viewer: string[]` key (a fallback chain like `["xdg-open {path}", "evince {path}"]`) — but it is currently parsed and ignored. The OS default wins regardless. If you want the chain honoured, file an issue or open a PR; the schema slot is already there.

## Deliverable lifecycle

Items that ship a deliverable go through a pattern:

1. **Early** — `## Deliverables` section exists but is empty or links to a stub PDF that says "draft pending".
2. **Review** — regenerate the PDF from the latest Markdown; status moves to `review`; share the PDF with reviewers.
3. **Final** — one last regeneration after review comments land; status moves to `done`.

If the deliverable is a living document (a standards doc, a runbook), skip the `done` status — leave the item in `review` and keep regenerating when needed. The status model is yours to interpret.

Do **not** check multiple versioned PDFs into the deliverables directory (`…-v1.pdf`, `…-v2.pdf`). Keep one canonical filename and rely on git for history. The card renders every `.pdf` file listed in the section, not every file on disk.

## Next

- [Search your history](search.md) — note that PDF **content** is not indexed, only the filename. Keep the source Markdown in `notes/` if you want the text searchable.
