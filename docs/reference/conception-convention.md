---
title: Status, steps, deliverables · condash reference
description: The content-level syntax condash reads out of each README body — step markers, deliverable links, and the folder layout that makes archiving free.
---

# Status, steps, deliverables

> **Audience.** Daily user.

## At a glance

Every item is a directory under `projects/YYYY-MM/YYYY-MM-DD-slug/` containing a `README.md`. There is no top-level `incidents/` or `documents/` folder — the `kind` field in the header discriminates.

Three body sections carry meaning to the parser: **`## Steps`** (and any other `##` section holding checkboxes, which contributes to the same progress count), **`## Deliverables`**, and **`## Timeline`**. Every other heading is rendered verbatim.

For the header format, see [README format](readme-format.md).

## Folder layout

```
conception/
├── projects/
│   ├── 2026-04/
│   │   ├── 2026-04-10-auth-rewrite/
│   │   │   ├── README.md
│   │   │   └── notes/
│   │   │       └── investigation.md
│   │   └── 2026-04-14-login-500s/           ← incident, same layout
│   │       └── README.md
│   └── 2026-03/
│       └── 2026-03-22-ci-upgrade/
│           └── README.md
├── knowledge/                                ← optional, explorer pane
│   └── …
├── .condash/                                 ← tree-level state (gitignored)
│   ├── settings.json                         ←   per-host config
│   └── logs/YYYY/MM/DD/HHMMSS-<sid>.txt      ←   per-session terminal capture (plain text + JSON header/footer)
└── condash.json                              ← legacy config (still read)
```

The `.condash/` directory is gitignored by default — the auto-migrator appends `.condash/` to your conception's `.gitignore` the first time it lifts a legacy `condash.json` into `.condash/settings.json`. See [Config files](config.md) for the read precedence and the migration mechanics.

Rules, enforced or conventional:

| Rule | Enforced by | Notes |
|---|---|---|
| Items live at `projects/YYYY-MM/YYYY-MM-DD-slug/README.md` | parser glob | Anything not matching `projects/*/*/README.md` is invisible. |
| Month folder is `YYYY-MM` | convention | The parser does not validate the folder name, but the wikilink resolver expects it. |
| Item folder starts with `YYYY-MM-DD-` | convention | Dashes; no spaces. The part after the date prefix is the short slug wikilinks resolve against. |
| Kind lives in the metadata block as `kind: …` | convention | Defaults to `project`. No separate directory per kind — they coexist under one month folder. |

The flat-month layout was a deliberate simplification of an earlier `projects/<slug>/` + `projects/YYYY-MM/<slug>/` split. Items never move between active and archive; a `Status: done` flip is the only archive signal, and there's nothing for `condash` to rename. See [why Markdown-first](../explanation/why-markdown.md) for the rationale.

## Status model

Five ordered values, highest-urgency first:

| Value | Meaning |
|---|---|
| `now` | Actively being worked on this week |
| `review` | Work done, awaiting review or verification |
| `later` | Agreed to do, not scheduled |
| `backlog` | Possible; worth keeping, not committed |
| `done` | Closed. Stays in its `YYYY-MM/` folder indefinitely. |

The status lifecycle, as a flow:

```
   later ────┐
   backlog ──┴── waiting states — join the active path when picked up

            (work shipped / proposal drafted)   (signal: verified)
   now ───────────────────────────────────▶ review ──────────────▶ done
    ▲                                           │                    │
    │ (needs rework)                            │ (reopen)           │
    │                                           │                    │
    └───────────────────────────────────────────┴────────────────────┘
```

`now` and `review` are the active path: work ships into `review`, and a positive signal (a merge, a verification) closes it to `done`. A negative signal sends it back to `now` for rework, and a `done` item reopens to `now` the same way. `later` and `backlog` are waiting states outside the active path — they hold an agreed-but-unscheduled item until it is picked up.

The parser normalises the value to lowercase and preserves it verbatim — there is **no silent rewrite** to `backlog`. Unknown values log a parser warning, sort after every known value (per `statusOrder` in [`src/shared/projects.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/projects.ts)), and make the card sprout a red `!? <value>` badge next to its status pill so typos (`wip`, `active`, …) stick out until corrected. A `status:` line that is absent altogether defaults to `backlog` (no badge). See [README format — Status](readme-format.md#status) for the full rule. Inside the dashboard, status changes via drag-and-drop rewrite the status line in place — `status:` for YAML-frontmatter READMEs, `**Status**:` for legacy bold-prose READMEs. See [mutations](mutations.md).

## Steps

Markdown checklists inside any `##`-level section. The dashboard's default "add step" target is a section literally named `## Steps`, but any section (for instance `## Phase 1`) can carry checkboxes and they all contribute to the item's progress count.

```markdown
## Steps

- [ ] Audit current session-cookie usage
- [~] Implement the hybrid read path
- [!] Migration script for existing tokens (blocked on schema sign-off)
- [x] Decide on cookie attributes
- [-] Feature flag (abandoned — shipping directly)
```

### Marker map

| Marker | Parsed status | Counted as done? |
|---|---|---|
| `[ ]` | `open` | no |
| `[~]` | `progress` | no |
| `[!]` | `blocked` | no |
| `[x]` or `[X]` | `done` | yes |
| `[-]` | `abandoned` | yes |

The dashboard's checkbox-click cycle is `open → progress → done → abandoned → open`, implemented in [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) (writer) and as `CLICK_CYCLE` in [`src/renderer/panes/projects-parts/data.ts`](https://github.com/vcoeur/condash/blob/main/src/renderer/panes/projects-parts/data.ts) (UI cycle order, re-exported through `projects.tsx`). The `[!]` (blocked) marker is **not** part of the cycle — set it by editing the README directly when work on a step is paused waiting for an external decision; the parser, counter, writer, and renderer all round-trip it without loss.

The canonical list of markers (and the parsing regex bracket class) lives in [`src/shared/types/project.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/types/project.ts) as `STEP_MARKERS`.

### Where to put steps

Keep the top-level `## Steps` list **short** — three to eight high-level milestones. Per-file tasks, acceptance criteria, and detailed implementation checklists belong in `notes/<name>.md`, not in the README. The README is the bird's-eye view; the notes folder is the workshop.

### Why no ordering semantics

The parser preserves source order. Drag-and-drop reorder rewrites the affected step lines in place (see [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts)) — there is no explicit index, priority, or ID on a step. Two steps with identical text are indistinguishable.

## Deliverables

The outputs an item produces — reports, executables, deployed pages, links — surfaced on the project card and in the **Deliverables** pane. Declared in a section literally named `## Deliverables`:

```markdown
## Deliverables

- [Technical report](rapport-technique.pdf) — full analysis with code references
- [Executive summary](summary.md) — one-page version for stakeholders
- [Latest wireframes](https://figma.com/file/…/mockups)
- [[2026-04-10-auth-rewrite]] — the audit this spin-off implements
```

Each line is a markdown link or a wikilink, with an optional trailing comment:

| Piece | Rule |
|---|---|
| Line start | `- [` (markdown link) or `- [[` (wikilink) |
| Label | any text until the next `]` |
| Target | a file relative to the item directory — **any extension** (pdf, md, html, image, …); an `http(s)://` URL, kept verbatim; or a `[[slug]]` wikilink to another conception item |
| Separator | optional em-dash (`—`), hyphen (`-`), or colon (`:`) |
| Comment | optional free text after the separator, shown beside the label |

`mailto:` and in-page `#anchor` targets are ignored. The parser ([`src/main/parse.ts`](https://github.com/vcoeur/condash/blob/main/src/main/parse.ts)) stops at the next `##` heading; lines that match none of the forms are silently skipped — a typo means the deliverable disappears from the card, no error.

See [Deliverables and PDFs](../guides/deliverables.md) for how each item opens (in-app viewers, external browser, OS default app), the download route, and the PDF.js previewer.

See [Deliverables and PDFs](../guides/deliverables.md) for the viewer config, the download route, and how the built-in PDF.js previewer kicks in.

## Timeline

An append-only human-facing log. The parser ([`src/main/parse.ts`](https://github.com/vcoeur/condash/blob/main/src/main/parse.ts)) reads the section to extract the `Closed.` date for done items and any structured `YYYY-MM-DD — text` entries; the dashboard surfaces the timeline in the project popover. Lines that don't match the date prefix are kept verbatim but ignored by the timeline view.

```markdown
## Timeline

- 2026-04-10 — Project created
- 2026-04-12 — Auth audit complete; see notes/investigation.md
- 2026-04-15 — Hybrid read path merged to main
```

One line per event, dated, imperative, linkable. Useful when re-reading the item months later — much cheaper than scrolling through commit history.

## Notes and subdirectories

Anything not in the README goes in `notes/<name>.md` (or any other subdirectory you create from the dashboard — `scripts/`, `drafts/`, whatever). The item preview's **Files** section renders the whole item directory as a collapsible tree: directories (empty ones included) toggle open/closed, files open in the in-app viewers, and every row has a hover affordance to open it with the OS. New files and folders can be created inline — at the item root or inside any directory. Hidden entries (leading `.`) and the top-level `README.md` are skipped. Top-level directories start expanded, except `local/` — the gitignored scratch dir by conception convention — which renders dimmed with a "gitignored" badge, sorts last, and starts collapsed.

The dashboard **creates** — `createProjectNote` for the next `notes/NN-<slug>.md`, `createProjectFile` and `createProjectDir` for the inline file-tree buttons — and **overwrites** an open note through `writeNote`. It does **not** rename, move, or upload into an item directory: there is no rename verb, and `treeImportFile` targets the Knowledge and Resources trees only. Use your shell for the rest. See [mutations](mutations.md) for the exact surface, and [Linking items with wikilinks](../guides/wikilinks.md) for the in-note link syntax.

## What is not part of the convention

- **No TOML frontmatter.** YAML frontmatter is the canonical header shape from v2.16.0; TOML frontmatter is ignored. The legacy bold-prose header is also accepted indefinitely. See [README format](readme-format.md).
- **No IDs.** The directory name is the identity. No UUIDs, no auto-incrementing counters.
- **No schema version.** The parser is backwards-compatible within a major version; new fields are additive.
- **No lock files.** Everything the dashboard knows is derived from the tree on every request.
- **No archive step.** Items live at `projects/YYYY-MM/YYYY-MM-DD-slug/` for life. Status flips, directories don't — so there's no "archive" or "tidy" workflow to trigger.
