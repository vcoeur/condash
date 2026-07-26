---
title: Link items with wikilinks · condash guide
description: Cross-link items and knowledge files with `[[slug]]`, understand exactly what the parser accepts, and know what happens when a target is missing.
---

# Link items with wikilinks

> **Audience.** Daily user.

**When to read this.** You want one item's README or note to point at another item, without copy-pasting a path that breaks the moment the item moves.

condash resolves `[[slug]]`-style wikilinks (Obsidian-style) inside rendered Markdown bodies. The resolver is deliberately narrow: it works on **slugs**, not on paths, so a link survives the item moving between months.

## Syntax

One shape, and only one:

```markdown
See [[fuzzy-search-v2]] for the related work.
```

Between `[[` and `]]` the parser accepts **only** `A–Z`, `a–z`, `0–9`, `_`, and `-`. The first character outside that set aborts the match and the text is left alone as literal Markdown.

That rules out, concretely:

| Written | What happens |
|---|---|
| `[[fuzzy-search-v2]]` | ✓ Resolves. |
| `[[2026-04-02-fuzzy-search-v2]]` | ✓ Resolves — the dated form. |
| The piped form, `[[target` + pipe + `label]]` | ✗ A pipe is rejected. Renders as literal text. |
| `[[knowledge/topics/sandbox]]` | ✗ `/` is rejected. Renders as literal text. |
| `[[project/some-slug]]`, `[[incident/…]]`, `[[documents/…]]` | ✗ Same — no prefix forms are supported. |
| `[[helio benchmark]]` | ✗ A space is rejected. Renders as literal text. |
| `[[sandbox.md]]` | ✗ A dot is rejected. Drop the extension. |

There is **no label form in bodies**. The rendered link text is the target *including its brackets* — a `[[fuzzy-search-v2]]` in your prose renders as a clickable `[[fuzzy-search-v2]]`. That is deliberate: a wikilink should read as a wikilink, not disguise itself as prose.

> **One exception.** The `## Deliverables` parser is a *different* code path and it does accept `- [[slug|label]] — comment`. That form works only on a deliverable line — see [Deliverables and PDFs](deliverables.md#the-deliverables-section).

Targets are case-sensitive.

## How a target resolves

condash builds one flat slug index and looks the target up in it. Two kinds of thing go into that index, **in this order**:

1. **Every project**, under both its full directory name (`2026-04-02-fuzzy-search-v2`) *and* its name with the `YYYY-MM-DD-` prefix stripped (`fuzzy-search-v2`).
2. **Every `.md` file anywhere under `knowledge/`**, keyed by its **basename minus `.md`** — at any depth. `knowledge/topics/testing/playwright-sandbox.md` is reachable as `[[playwright-sandbox]]` and by nothing else; the directories it sits in are not part of the key.

Because projects go in first, **a project slug always wins a collision** with a knowledge basename of the same name.

The short (undated) project form is what you'll use almost always. The dated form exists for the rare case where two months hold the same slug and you need to name one exactly.

### When several items match

If the short form matches more than one project, condash opens the **first** one in index order and flashes an info toast:

> `[[fuzzy-search-v2]] matched 2 items — opening the first`

There is no date sort and no disambiguation picker. If you need a specific one, use its full dated slug.

## What a missing link looks like

A wikilink that resolves and a wikilink that doesn't **render identically** — same anchor, same styling, no tooltip, no grey-out. Nothing is looked up until you click.

Clicking an unresolvable one flashes an error toast:

> `No item matches [[benchmark-harness-v3]]`

So a typo shows up on click, not on render. If you want a link you can trust at a glance, click it once after writing it.

## Where wikilinks work

- **README bodies** — anywhere in the free-text sections (Goal, Scope, Timeline, …) and inside step text.
- **Note bodies** — every `.md` file under `<item>/notes/`.
- **Knowledge-tree files** — any `.md` under `knowledge/`.
- **Visual notes** — the prose between blocks in an `.mdx` file renders through the same pipeline, and clicks route the same way. See [Visual notes](plan-documents.md).
- **Deliverable lines** — with the extra `|label` form noted above.

Wikilinks do **not** work inside YAML/TOML config, inside filenames, or inside the `**Key**: value` header block of a README. They're a body-only feature.

## A worked example

The demo tree has several cross-linked items. From `fuzzy-search-v2`'s `notes/design.md`:

```markdown
> See also: [[helio-benchmark-harness]] — the shared harness we're extracting
> the parser benchmarks into.
```

That resolves to `projects/2026-04/2026-04-18-helio-benchmark-harness/README.md`. Clicking it opens that item's card directly — no URL to copy, no path to update if the item moves to a different month.

The other direction, from `helio-benchmark-harness`'s README:

```markdown
- [ ] Document the harness in [[fuzzy-search-v2]] so that item's benchmarking
      notes stop living in a standalone file.
```

Both short-form, both resolve. Note there is no pipe: the step line has to read well with the bracketed slug in it, which is a small tax for a link that never rots.

## Interaction with Markdown syntax

Wikilinks are a markdown-it inline rule (`src/renderer/wikilinks.ts`) that runs before emphasis, rewriting each `[[…]]` match into an `<a class="wikilink">` anchor. Consequences:

- You can freely mix `[regular markdown](links)` and `[[wikilinks]]` on the same line.
- There is no escape for `[[` — if you need a literal one, wrap it in a code span (`` `[[not a link]]` ``).
- Wikilinks inside fenced code blocks are left as literal text.
- Because the rule bails on the first illegal character, a malformed target is never *half*-parsed. It is simply prose.

## Next

- Cross-linking is most useful in notes; see [Your first project](../get-started/index.md#your-first-project) for the full notes-editing surface.
- To link out to specific reference material instead of other items, see [The knowledge tree](knowledge-tree.md).
