---
title: Guides · condash
description: Task-focused how-tos for the parts of condash you probably won't discover by browsing.
---

# Guides

Each guide answers one specific question.

**Setup**

- **[Configure the conception path](configure-conception-path.md)** — change the folder condash renders, with the menu, the CLI, or by editing `settings.json`.
- **[Repositories and open-with launchers](repositories-and-open-with.md)** — the workspace and worktrees paths, the repositories list, and the IDE/terminal launch slots behind the Code pane.
- **[The Settings modal](settings-modal.md)** — one scrolling modal, two files with disjoint schemas, and which setting lives where.
- **[Applications and handles](applications-and-handles.md)** — identify each app by one canonical `#handle`, manage the registry, keep `apps:` references resolving.
- **[Auto-commit](auto-commit.md)** — let condash be the single writer for a versioned conception: commit settled changes on a timer and push.

**The panes**

The left activity rail switches four **left-band** views and five **right-slot** working surfaces.

- **[The Code pane](code-pane.md)** — what the repo cards, branch rows, and worktrees mean.
- **[The Tasks pane](tasks-pane.md)** — save reusable, parameterized agent prompts, fill their `{markers}` in a form, and run them with one click.
- **[The Deliverables pane](deliverables-pane.md)** — every project's `## Deliverables`, aggregated and grouped by project.
- **[The Performance pane](performance-pane.md)** — per-tab memory, growth rate, and throttle state, plus main-process event-loop delay.
- **[The knowledge tree](knowledge-tree.md)** — durable reference material as cards, with freshness stamps.
- **[The Resources pane](resources-pane.md)** — every file under `resources/` as a card with view / open / copy / paste-to-term actions.
- **[The Skills pane](skills-pane.md)** — browse the markdown skills condash ships under `.agents/skills/`, with shipped/diverged chips.
- **[The Logs pane](logs-pane.md)** — saved session transcripts by day, a virtualised viewer with search, and the task-run store.

**Daily**

- **[Use the embedded terminal](terminal.md)** — toggle, dock, prefer your shell, screenshot paste, session logging.
- **[The Dashboard](dashboard.md)** — turn a wall of terminal tabs into a card each: what it's doing and which one is waiting on you.
- **[Agent CLIs and model providers](agent-clis-and-models.md)** — pair any agent CLI with any model provider via wrapper scripts, and register each as a launcher.
- **[Search](search.md)** — full-text across every README, note, knowledge file, resource, and skill. Read the ranking; read the snippets.
- **[Link items with wikilinks](wikilinks.md)** — `[[other-item]]` resolves across the tree.
- **[Deliverables and PDFs](deliverables.md)** — the `## Deliverables` syntax, the in-app viewers, and Export as PDF.
- **[Visual notes (plans, reviews, designs)](plan-documents.md)** — `.mdx` documents of typed blocks, and `condash mdx check`.
- **[Troubleshooting](troubleshooting.md)** — Wayland blur, dirty caches, killed tabs, app won't launch.

**Extending**

- **[Extend the management skills](skill-extensions.md)** — fork or wrap the five shipped skills without losing upstream updates.
- **[Dev launch](dev-launch.md)** — run condash from a clone with hot reload, and the test targets that guard it.

**More**

- [A day with condash](../tutorials/daily-loop.md)

→ Looking up rather than doing? **[Reference](../reference/index.md)**.
