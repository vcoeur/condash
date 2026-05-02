---
title: condash — Markdown project dashboard
description: Live desktop dashboard for a Markdown-first project-tracking convention. Your projects, incidents, and documents are plain .md files you already edit; condash gives you the polished view on top.
---

# condash

<p class="tagline">A dashboard for the Markdown you already write.</p>

`condash` is a single-user desktop app that renders a live view of a folder of **projects**, **incidents**, and **documents** written as plain Markdown. No database, no sync server, no account — the files are the source of truth, and `condash` is the view on top.

![condash dashboard overview](assets/screenshots/dashboard-overview-light.png#only-light)
![condash dashboard overview](assets/screenshots/dashboard-overview-dark.png#only-dark)

## Start here

<div class="grid cards" markdown>

-   **:material-rocket-launch: New here**

    [Install →](get-started/install.md) · [First launch →](get-started/first-launch.md) · [Walkthrough →](tutorials/first-run.md)

-   **:material-tools: Already using it**

    [Use →](guides/index.md) · [Reference →](reference/index.md) · [Troubleshooting →](guides/troubleshooting.md)

-   **:material-help-circle-outline: Curious why**

    [Why Markdown-first →](explanation/why-markdown.md) · [Non-goals →](explanation/non-goals.md)

</div>

## Install in one minute

Download for your OS from **[github.com/vcoeur/condash/releases/latest](https://github.com/vcoeur/condash/releases/latest)**:

| OS | File |
|---|---|
| Linux | `condash-<version>.AppImage` or `condash_<version>_amd64.deb` |
| macOS | `condash-<version>.dmg` |
| Windows | `condash Setup <version>.exe` |

Debian/Ubuntu users can use the apt repository instead — see **[Install → Linux apt](get-started/install.md#linux-apt-repository-recommended)**.

The builds are unsigned; each OS asks you to confirm once on first launch. Full walkthrough: **[Install →](get-started/install.md)**.

> `git` must be on `PATH` — condash shells out to it for repo status.

## What it does

- **Renders your folder** — Projects (Current / Next / Backlog / Done), Code (your repos), Knowledge (your reference notes), History (full-text search). Live: changes on disk show up immediately.
- **Mutates a small set of lines** — toggle a step, change a status, save a note, edit `configuration.json`. Everything else stays yours to write.
- **Provides a CLI** — the same `condash` binary serves a command line: `condash projects list`, `condash search "…"`, etc. See **[CLI reference](reference/cli.md)**.

## What it doesn't

- No multi-user collaboration. Single-user, local-only.
- No web UI, no embedded HTTP server.
- No code editing — source files open in your IDE via configurable launcher slots.
- No telemetry. Nothing leaves your machine except auto-update checks against GitHub Releases.

The full list with rationale: **[Non-goals →](explanation/non-goals.md)**.

## Documentation map

| Section | When to read |
|---|---|
| **[Get started](get-started/index.md)** | First time, fresh install — install, first launch, walkthroughs |
| **[Use](guides/index.md)** | Looking for a specific how-to |
| **[Reference](reference/index.md)** | Looking up a key, flag, or file format |
| **[Background](explanation/index.md)** | Understanding why condash is shaped this way |

## Links

- [Source on GitHub](https://github.com/vcoeur/condash)
- [Latest release](https://github.com/vcoeur/condash/releases/latest)
- [Issue tracker](https://github.com/vcoeur/condash/issues)
- [Author](https://vcoeur.com)
