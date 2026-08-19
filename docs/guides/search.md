---
title: Search · condash guide
description: Use the search modal's full-text search across every README, note, and knowledge file. Read the ranking, read the snippets, find what you wrote six months ago.
---

# Search

> **Audience.** Daily user.

**When to read this.** You remember writing something — a note, a README paragraph, a step description — and you need to find it without grepping the tree by hand.

condash's search is a **modal**, not a pane. It's available from anywhere in the app:

- **`Ctrl+Shift+F`** / **`Cmd+Shift+F`** — opens the modal.
- **`Ctrl+K`** / **`Cmd+K`** — alias of the above; matches the cheat-sheet's primary, intended for VS Code / Linear / Slack muscle memory.
- **File → Search…** — same.

The query box takes focus the moment the modal opens. Start typing; results render live, ranked and grouped by item. `Esc` closes the modal.

To narrow the **Projects pane itself** rather than get a ranked list — a README-content search that just hides non-matching cards, combined with a starred toggle and an apps multiselect — use the pane's own [filter bar](projects-pane.md#filter). It runs over the same index, README content (or the item's slug) only.

## What's indexed

Four Markdown sources are held in an in-memory index, plus terminal logs which are scanned from disk on demand:

| Source | What's walked | Extensions |
|---|---|---|
| **Projects** | Every file under `projects/<month>/<item>/`, at any depth — the README, everything in `notes/`, and anything else you put there | `.md` |
| **Knowledge** | Everything under `knowledge/`, at any depth | `.md` |
| **Resources** | Everything under `resources/` | `.md`, `.markdown`, `.txt` |
| **Skills** | Everything under `.agents/skills/` | `.md` |
| **Logs** | Saved session transcripts under `.condash/logs/` — **only** with the Logs filter picked | `.txt` |

For each file, the **path** is indexed alongside the content, so you can find a note by its filename even when the body doesn't match.

There is no file-size cap: every file matching those extensions is indexed in full.

## Source filters

Once your query is long enough, a row of filter pills appears: **All · Projects · Knowledge · Resources · Skills · Logs**. The default is **All**, which searches the four Markdown sources held in the in-memory index — so results land in milliseconds even on a large conception.

**Terminal logs are not in the default results.** They're the bulk of the searchable bytes and rarely searched, so the default **All** view skips them to stay fast. To search transcripts, pick the **Logs** pill — that scans the log tree on demand and lists matching sessions (click one to open it in the log viewer). Because logs aren't scanned under **All**, the Logs pill shows a hit count only while it's the active filter.

## Ranking

Every occurrence scores by the **region of the file** it landed in — not by what kind of file it is:

| Region | Weight |
|---|---|
| `h1` — the file's first `# Heading` | 20 |
| `meta` — the `**Field**: value` header block right after the H1 (project files only) | 15 |
| `heading` — any other `#`-prefixed line | 5 |
| `path` — a match in the file's path | 5 |
| `body` | 1 |

Two bonuses sit on top:

- **+5 per matched phrase term.** A `"quoted phrase"` that matched earns it — phrases imply adjacency, so they're worth a little over a bare token.
- **+10 for adjacency**, once per file, when two *different* query tokens land within 30 characters of each other. Path hits are excluded from this: a path is too short for adjacency to mean anything.

A title hit is worth twenty body hits, which is the point — a file *about* your query beats a file that merely mentions it. The final list is ordered by total score, with ties broken by **file modification time** (newest first), then by path alphabetically.

**The result list is capped at 100 hits.** When more matched, the modal shows a *Showing 100 of N* footer.

## Token matching

The query is lower-cased and split on whitespace, preserving order. `"Double-quoted strings"` become a single **phrase** term that must match contiguously — useful for `"force stop"` or `"exit code"`. Results must match **every** term (AND semantics); a term may match in the body *or* in the path.

There is no OR operator, no `-exclusion`, no field scoping, and no escape character. Repeated tokens are **not** de-duplicated — typing `parser parser` matches twice and scores twice.

All matches are substring matches. Token `fuzz` matches `fuzzy`, `fuzzing`, and `defuzz`; no stemming, no fuzzy matching, no synonyms. Case is ignored.

## Snippets

Each hit carries **up to three** non-overlapping snippets — the text around a match, with every matched substring highlighted:

> …to index the **corpus** with the same format as the parser's real input.

Rules:

- Snippets are ordered by region precedence: `meta` first, then `h1`, then `heading`, then `body`. So the most identifying context surfaces first.
- Radius is 60 characters on either side of the hit. Once a window is committed, later matches falling inside it are skipped.
- The window is a raw character slice — it does **not** snap to word boundaries, so a snippet can start or end mid-word.
- Whitespace collapses to single spaces.
- Ellipses indicate truncation on either side.
- Every occurrence of every query term inside the snippet is highlighted, not just the anchor.

A hit with no snippet matched only in the path; it still shows, labelled by its source.

## Result layout

Each result has:

- The **item title and kind glyph** — click to open that item's card.
- One or more **hit rows** underneath, each showing its source, the file's path, and up to three snippets with the matched terms highlighted.

Click any result to close the modal and jump to the corresponding card, knowledge file, or log session. When the raw hit count exceeded 100, a *Showing 100 of N* footer tells you the list was truncated — narrow the query rather than scrolling.

## What isn't searched

- Any extension outside the table above — images, PDFs, archives, and source files never reach the index at all, not even by filename.
- Dot-prefixed files and directories **below** a source root (`.git/`, `.venv/`, …). The roots themselves may be dotted — `.agents/skills/` and `.condash/logs/` are always descended into.
- `node_modules/`, `local/`, `dist/`, and `target/`, wherever they appear under a root. (`local/` is where gitignored deliverables live.)
- `deliverables/` PDF **text** — condash doesn't extract PDF content, and a `.pdf` is not an indexed extension, so neither its text nor its path is searchable.

If you need to search inside deliverable PDFs, grep them with an external tool or generate a searchable Markdown alongside the PDF (see [Deliverables and PDFs](deliverables.md)).

## Practical patterns

- **"Where did I write about X?"** — type `X`. Titles and paths surface first; body matches follow.
- **"What did I say about X in the Y project?"** — type `X Y`. Both tokens must match; results narrow to files that carry both, and the adjacency bonus floats the ones where they appear together.
- **"Find the note about the config migration"** — type `config migration`. Both words in the path (e.g. `notes/config-migration-decision.md`) score 5 each, which outranks a passing body mention. Path hits are deliberately excluded from the adjacency bonus — a path is too short for proximity to mean anything.
- **"That exact phrase"** — quote it: `"force stop"`. The phrase must match contiguously and earns the phrase bonus.
- **"What's our convention for X?"** — knowledge files rank in the same list; a match in `knowledge/conventions.md` shows alongside project hits.

## CLI parity

The same search engine is exposed by `condash search`:

```bash
condash search "session cookie" --scope all --limit 20
condash search fuzz --json | jq '.data.hits[].path'
```

`--scope` accepts `all`, `projects`, `knowledge`, `resources`, `skills`, `logs` (default `all`, which is the four Markdown sources — logs are disk-scanned and only searched with `--scope logs`). `--limit` defaults to `50`. See [CLI reference — search](../reference/cli.md#search).
