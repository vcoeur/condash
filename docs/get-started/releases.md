---
title: Releases · condash
description: How to find the latest condash release, what the version scheme means, and how to upgrade.
---

# Releases

> **Audience.** New user and Daily user.

condash is shipped as a pre-built desktop binary on GitHub Releases. This page is about **finding the right version** — one link above all else: **[releases/latest](https://github.com/vcoeur/condash/releases/latest)**.

Installing for the first time? Start at **[Get started → Install](index.md#install)** instead; this page is the background on what the numbers mean.

## Version scheme

Tags follow `vMAJOR.MINOR.PATCH`:

| Segment | Bumps when… | Example |
|---|---|---|
| PATCH | Bug fix, docs update, non-behaviour change | `v4.99.2` → `v4.99.3` |
| MINOR | New feature or user-visible behaviour change | `v4.98.X` → `v4.99.0` |
| MAJOR | Breaking change — config or Markdown format | `v3.X.X` → `v4.0.0` |

Patches are the norm. Most weeks there's at least one; MINOR bumps are rarer, MAJOR is a special event.

There is no version-bump commit — `package.json` carries a placeholder and the real version is injected from the tag at build time. The tag *is* the version.

### Prerelease tags

The release workflow also accepts a suffix: `v4.99.4-rc.1`, `-alpha.2`, `-beta.1`. Those ship as **prereleases** — they never become `releases/latest`, but they are real published releases with real assets.

Two consequences worth knowing:

- A `releases/latest` that looks a version or two behind is usually correct, not broken: the newest tag is a prerelease and `latest` deliberately skips it.
- The **apt index does not skip them**. It is rebuilt from the most-recent 5 non-draft releases regardless of channel, so `apt install condash` can hand you an `-rc` build. Download a plain `vX.Y.Z` `.deb` if you want stable only.

A tag is also rejected outright unless its commit is reachable from `origin/main`, so a release can never be cut from an unmerged branch.

## Major versions

condash's history spans three implementations and four major lines. Only the Electron line (`2.x`–`4.x`) is current; `0.x` (Python) and `1.x` (Rust/Tauri) are frozen in separate repos.

| Major | What it was |
|---|---|
| `0.x` | Python (NiceGUI + FastAPI). Frozen at [`vcoeur/condash-python`](https://github.com/vcoeur/condash-python). |
| `1.x` | Rust + Tauri rewrite. Frozen at [`vcoeur/condash-tauri`](https://github.com/vcoeur/condash-tauri). |
| `2.x`–`4.x` | Electron rewrite — the current canonical build. |

### Migrating from condash 3.x → 4.x

**v4.0.0 narrowed what condash does with agent config.** Earlier 3.x builds compiled per-agent instruction files for you; 4.0.0 removed that pipeline entirely. If you used any of the following, it is gone:

- The `.agents/agents/` source tree (`common.md` / `condash.md` / `conception.md` / `claude.md` / `kimi.md`) — no longer read.
- The root `opencode.json` pointer condash used to write — no longer written.
- `condash project build` — removed.
- `condash skills install --user` — removed (condash no longer writes `~/.claude/skills/` or `~/.kimi/skills/`).

What `condash skills install` does now is just two things: ship your `.agents/skills/<name>/` sources **verbatim**, and maintain condash's marker region inside `AGENTS.md`. Rendering `AGENTS.md` into per-agent views (`.claude/CLAUDE.md`, `.kimi/AGENTS.md`, …) is now the job of your harness launcher, not condash — those files are produced at launch and are never written to disk by condash. If you have leftover `.agents/agents/` or a condash-written `opencode.json`, they are simply inert; delete them at your convenience.

Agent launchers also changed shape in this line: they are now a flat `{ id, label, command }` list under the `agents` config key, edited in the **[Settings modal](../guides/settings-modal.md)** — see **[Agent CLIs and model providers](../guides/agent-clis-and-models.md)**.

### Inside the 4.x line

The line is still on `4`, and by the scheme above that means nothing since 4.0.0 has broken a config key or the Markdown format — upgrading within `4.x` needs no migration. The additions worth knowing about:

| Landed in 4.x | What it added |
|---|---|
| The activity rail | The left icon rail, plus the Tasks, Deliverables, and Performance views behind it. |
| The [Dashboard band](../guides/dashboard.md) | LLM summaries of what each terminal tab is doing. Off by default; needs an API key. |
| [Auto-commit](../guides/auto-commit.md) + `condash sync run` | condash as the single git writer for a shared conception checkout. |
| The RAM search index | Search stopped re-walking the tree per query. Logs stay on-disk-scanned. |
| `parent:` / subprojects | Link a spin-off item to the plan it derives from — see [README format](../reference/readme-format.md#parent-subprojects). |
| `#handle` app registry | Stable app identity across items and repos — see [Applications and handles](../guides/applications-and-handles.md). |
| The `/visual` skill + `.mdx` notes | Visual plans, designs, and reviews — see [Visual notes](../guides/plan-documents.md). |

## Finding the latest

Three paths:

- **The latest-release shortcut.** `https://github.com/vcoeur/condash/releases/latest` always redirects to the current top published release. If you don't care about the version number, start there.
- **The all-releases list.** `https://github.com/vcoeur/condash/releases` shows the chronological list, prereleases included. Scroll to see changelogs per release.
- **The running app.** **Help → About Condash** shows the version you have, alongside the Electron / Chrome / Node versions it was built against. (There is no status-bar version and no link from About to that release — copy the number and paste it after `releases/tag/v`.)

## Release notes

Each release carries:

- A short summary in the release body — the per-OS install-bypass note, plus whatever the maintainer added.
- The full commit list between this tag and the previous, auto-generated by GitHub.
- The per-OS artifacts attached, plus `latest*.yml` and `*.blockmap` files. Those last two are electron-builder's update-channel metadata; condash does not use them and neither do you — ignore them.

## Nothing sits in draft

Releases are published directly. The workflow explicitly sets `draft=false` on both the create and the update path, and channel is decided purely by the tag suffix (see [Prerelease tags](#prerelease-tags)). So a `releases/latest` that looks stale is never "still in draft" — it means the newest tag was a prerelease, or the build is still running. The **Actions** tab shows build progress; a failing lane stops the pipeline before any Release is created, so the tag exists in git but nothing public ships.

## Upgrading

condash does not auto-update. Install and upgrade are out-of-band:

- **apt** on Debian/Ubuntu — `sudo apt update && sudo apt upgrade`, with the prerelease caveat above.
- **`dpkg -i`** or the `.deb` / `.AppImage` / `.dmg` / `.exe` directly from the release page.
- **From source** — clone, `make install` (which is `npm install`, not a system install), then `make package` to build installers or `make start` to run the built app in place. There is no source-install target.

The `electron-updater` dependency is wired as a no-op so it stays tracked; the packaged build never checks the GitHub Releases feed on launch.

To track releases, subscribe to the repo's **Releases** tab on GitHub — you'll get an email when a new version ships.
