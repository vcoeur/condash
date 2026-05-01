---
title: condash — Markdown project dashboard
description: Live desktop dashboard for a Markdown-first project-tracking convention. Your projects, incidents, and documents are plain .md files you already edit; condash gives you the polished view on top.
---

# condash

<p class="tagline">A dashboard for the Markdown you already write.</p>

`condash` is a single-user desktop app that renders a live dashboard of a directory of **projects**, **incidents**, and **documents** written as plain Markdown. No database, no sync server, no account — the Markdown files are the source of truth, and `condash` is the view layer.

![condash dashboard overview](assets/screenshots/dashboard-overview-light.png#only-light)
![condash dashboard overview](assets/screenshots/dashboard-overview-dark.png#only-dark)

## Where do I go?

Pick the entry point that matches your situation:

<div class="grid cards" markdown>

-   **:material-rocket-launch: I'm new — get me started**

    [Install →](get-started/install.md) · [First launch →](get-started/first-launch.md) · [First-run tutorial →](tutorials/first-run.md)

    Audience: never used condash, may not know what "conception" means yet.

-   **:material-tools: I use condash — I need to do something**

    [Guides →](guides/index.md) · [Troubleshooting →](guides/troubleshooting.md) · [Reference →](reference/index.md)

    Audience: knows the basics, wants a how-to or a lookup.

-   **:material-code-tags: I want to change condash**

    [Values →](explanation/values.md) · [Non-goals →](explanation/non-goals.md) · [Internals →](explanation/internals.md) · [Contributing →](explanation/contributing.md)

    Audience: developer evaluating, designing, or contributing changes.

-   **:material-help-circle-outline: I just want to know why**

    [Why Markdown-first →](explanation/why-markdown.md)

    The pitch. Files in git over a SaaS, the dashboard as a thin view layer, three good-fit scenarios.

</div>

## Install in one minute

**Linux, macOS, Windows** — download the installer for your OS from the latest GitHub Release:

→ **[github.com/vcoeur/condash/releases/latest](https://github.com/vcoeur/condash/releases/latest)**

| OS | File to download |
|---|---|
| Linux | `condash-<version>.AppImage` (or `condash_<version>_amd64.deb`) |
| macOS | `condash-<version>.dmg` |
| Windows | `condash Setup <version>.exe` |

Debian/Ubuntu users can skip the manual download and use the apt repository — see **[Install → Linux apt](get-started/install.md#linux-apt-repository-recommended)**.

The builds are **unsigned** — each OS asks you to confirm once on first launch. Full walkthrough: **[Install →](get-started/install.md)**.

> **Runtime requirement.** condash shells out to `git` for status and worktree information, so `git` must be on `PATH`. Linux distros ship it; on macOS install Xcode Command Line Tools (`xcode-select --install`) or Homebrew git; on Windows install [Git for Windows](https://git-scm.com/download/win).

Building from source (Node.js 20+ and, on Linux, Electron's native deps — `libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0`):

```bash
git clone https://github.com/vcoeur/condash.git
cd condash
make install    # one-off — npm install
make dev        # watch mode: tsc + vite + electron
```

## What it does, in three bullets

- **Renders your conception tree** — the dashboard reads `<conception>/projects/`, `knowledge/`, and `configuration.json`, then displays Projects (Current / Next / Backlog / Done), Code (your repos), Knowledge (your reference notes), and History (full-text search). Live — chokidar fires on every file change.
- **Mutates a small set of lines** — toggle a step, change a status, save a note, edit the JSON config. Everything else is yours to write in your editor or via the management skill.
- **Provides a CLI** — the same `condash` binary serves a CLI surface (`condash projects list`, `condash search "…"`, etc.). Skills and shell scripts use it instead of re-implementing condash's parser. See [CLI reference](reference/cli.md).

## What it doesn't do

- No multi-user collaboration. condash is single-user, local-only.
- No web UI, no embedded HTTP server.
- No code editing. Source files open in your IDE via configurable launcher slots.
- No telemetry. Nothing is sent anywhere except the GitHub Releases feed for auto-updates.

The full list with rationale lives at **[Non-goals →](explanation/non-goals.md)**.

## Documentation map

The docs follow [Diátaxis](https://diataxis.fr/) — four sections, each with a clear job:

| Section | When to read | What you'll find |
|---|---|---|
| **[Get started](get-started/index.md)** | First time, fresh install | Install bypass, first launch, releases |
| **[Tutorials](tutorials/index.md)** | Learning by doing | Three linear walks: first run, first project, a day's work |
| **[Guides](guides/index.md)** | Specific task | Configure paths, terminal, wikilinks, knowledge tree, troubleshooting |
| **[Reference](reference/index.md)** | Looking it up | Every CLI verb, config key, IPC verb, README field, mutation, shortcut |
| **[Explanation](explanation/index.md)** | Understanding why | Markdown-first pitch, design values, internals, non-goals, contributing |

## Links

- [Source on GitHub](https://github.com/vcoeur/condash)
- [Latest release](https://github.com/vcoeur/condash/releases/latest)
- [All releases](https://github.com/vcoeur/condash/releases)
- [Issue tracker](https://github.com/vcoeur/condash/issues)
- [Author](https://vcoeur.com)
