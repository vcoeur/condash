---
title: condash — Markdown project dashboard
description: Live desktop dashboard for a folder of Markdown projects, incidents, and documents. The files stay yours — condash is the view on top.
---

# condash

<p class="tagline">A dashboard for the Markdown you already write.</p>

`condash` is a **single-user desktop app** that renders a live view of one folder of plain Markdown files — your **projects**, **incidents**, and **documents**. No database, no sync server, no account. The files are the source of truth; condash is the view on top, and the handful of edits it makes are lines you could have typed by hand.

It exists for one person tracking work across several codebases: a solo maintainer, an engineering logbook, a workspace shared with an AI coding agent. If you already keep work notes in a git repo, condash is the front end that was missing.

![The condash dashboard: a Projects pane grouping items under NOW, REVIEW and LATER, and a Code pane listing five git repos with their branches](assets/screenshots/dashboard-overview-light.png#only-light)
![The condash dashboard: a Projects pane grouping items under NOW, REVIEW and LATER, and a Code pane listing five git repos with their branches](assets/screenshots/dashboard-overview-dark.png#only-dark)

## What is a conception?

A **conception** is the folder condash renders. It is an ordinary directory in an ordinary git repo — nothing in it is a condash file format:

```
conception/
├── projects/
│   └── 2026-07/
│       └── 2026-07-26-try-condash/
│           ├── README.md          ← one item = one folder, one README
│           ├── notes/             ← long-form working notes
│           └── deliverables/      ← PDFs, exports, anything you produced
├── knowledge/                     ← durable reference notes, not tied to an item
├── resources/                     ← loose files you want at hand
└── .condash/settings.json         ← which repos and paths this tree knows about
```

Every item is one dated directory with a `README.md` inside it. The README's YAML frontmatter carries `status`, `kind`, and which apps it touches; its `## Steps` section is a GitHub-style checklist. That is the whole convention — [README format](reference/readme-format.md) writes it down in full, and everything else in the tree is free-form Markdown.

Because it is only files, everything else still works: `git diff` shows what changed when you flip a step, `rg` finds a decision from two years ago in milliseconds, your editor opens it, and an agent can read and write it with no integration layer at all.

Don't have a conception yet? condash ships one — [step 2 of Get started](get-started/index.md#first-launch) has it lay a working tree down for you.

## Start here

- → **[Get started](get-started/index.md)** — install, open or initialise a tree, create an item, then watch the file change on disk. About ten minutes, with a checkpoint at every step.
- → **[A day with condash](tutorials/daily-loop.md)** — the realistic loop once you have items: open one, work in its repo, run something in the embedded terminal, push a PR, close.
- → **[Why Markdown-first](explanation/why-markdown.md)** — the argument, if you'd rather be convinced before you install.

## Sections

- **[Get started](get-started/index.md)** — install, first launch, your first item.
- **[Tutorials](tutorials/index.md)** — learn condash by working through a realistic day.
- **[Guides](guides/index.md)** — task-focused how-tos, one per surface.
- **[Reference](reference/index.md)** — every key, flag, and file format.
- **[Background](explanation/index.md)** — why condash is shaped this way.

## Links

- [Source on GitHub](https://github.com/vcoeur/condash)
- [Latest release](https://github.com/vcoeur/condash/releases/latest)
- [Issue tracker](https://github.com/vcoeur/condash/issues)
- [Author](https://vcoeur.com)
