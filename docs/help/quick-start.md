# Quick start

Four steps: install, open a folder, create an item, watch the file change.

A **conception** is the folder condash renders: a plain directory of
Markdown projects and knowledge notes, usually a git repo. Everything on
this page builds one — or point condash at a Markdown folder you already
have and it renders that.

## 1. Install

Download the latest release for your OS from
**https://github.com/vcoeur/condash/releases/latest**:

| OS | Asset |
|---|---|
| Linux | `condash-<version>.AppImage` or `condash_<version>_amd64.deb` |
| macOS | `condash-<version>-arm64.dmg` |
| Windows | `condash.Setup.<version>.exe` |

Debian/Ubuntu users can install from the signed apt repository instead:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://condash.vcoeur.com/apt/pubkey.asc \
  | sudo gpg --dearmor -o /etc/apt/keyrings/condash.gpg
echo "deb [signed-by=/etc/apt/keyrings/condash.gpg] https://condash.vcoeur.com/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/condash.list
sudo apt update && sudo apt install condash
```

Note that the apt index covers the most-recent 5 releases *including
prereleases*, so `apt install condash` can hand you an `-rc` build.
Download a plain `vX.Y.Z` `.deb` if you want stable only.

The builds are unsigned. Each OS asks you to confirm the download once
on first launch (control-click → Open on macOS; "More info → Run anyway"
on Windows; nothing extra on Linux).

`git` must be on `PATH` — condash shells out to it for repo status.

## 2. Open a folder

Nothing opens automatically. Launch condash and you get one line of text
and one button:

> Pick a conception directory to list its projects.
>
> [ **Choose folder…** ]

Click it — or use **File → Open…** (`Ctrl+O`) — and pick any directory,
for example `~/conception`. condash writes the choice into `settings.json`
(key `lastConceptionPath`) and reuses it next time.

If the folder is missing `projects/` or a config file, condash offers to
seed it:

> **Initialise from template?**
> This folder is missing projects/ and a condash config file.
>
> Initialise it from the bundled conception template? Skill files, seed
> indexes, and example config will be laid down. Existing files are left
> alone.

Click **Initialise** and you get a working tree in one step: `AGENTS.md`,
`.condash/settings.json`, `projects/index.md`, a seeded `knowledge/`, and
the five shipped skills under `.agents/skills/`. Existing files are never
overwritten.

To switch trees later: **File → Open…** (`Ctrl+O`), or **File → Open
Recent** for the last five.

## 3. Create an item

Three equivalent ways to open the create-item modal: the **+ New
project ▾** button on the `NOW` section header, the **+ New** button in
the Projects pane header, or **File → New project…** (`Ctrl+N`).

A tree with **no projects and no `knowledge/` content** shows a
**Welcome screen** first, with four cards — **Create your first
project**, **Open my tree**, **Read the welcome doc**, **Open the
documentation site** — plus a **Don't show this again** link that
persists the dismissal (`welcome.dismissed`). Note that the template
init seeds `knowledge/`, so a folder you just initialised skips the
Welcome screen and lands straight on the dashboard.

The modal asks for four things, in this order:

- **Title** — free text.
- **Slug** — auto-derived from the Title, with an **edit** button to
  override.
- **Kind** — `project`, `incident`, or `document`. Choosing `incident`
  reveals Environment / Severity / Severity impact.
- **Status** — `now`, `review`, `later`, or `backlog`.

Click **Create**. condash writes
`projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/README.md` and an empty `notes/`
beside it:

```markdown
---
date: 2026-07-26
kind: project
status: now
apps: []
---

# My title

## Goal

<What this project aims to achieve — the user-facing outcome.>

## Scope

<What is in scope and what is explicitly out of scope.>

## Steps

- [ ] <first task>

## Timeline

- 2026-07-26 — Project created.

## Notes
```

You can also hand-create items — `mkdir` the folder and drop a README
with that header. Legacy bold-prose headers (`**Date**: 2026-07-26`,
etc.) are still accepted; see
**https://condash.vcoeur.com/reference/readme-format/**. condash picks
it up live.

## 4. Watch the file change

Open the item and click the marker button next to a step. The marker
cycles `[ ]` → `[~]` → `[x]` → `[-]`, and condash rewrites exactly that
one line of the README. `cat` the file, or `git diff` it: nothing else
moved. That is the whole model.

## Editing settings

**File → Settings** (`Ctrl+,`) opens a single full-viewport modal —
one scrolling surface whose left rail groups sections under two scope
headers, one per file. Every setting has exactly one home, so there are
no tabs, no inheritance, and nothing to override.

- **Personal · this machine** (writes `settings.json`) carries Recent
  conceptions, Appearance, Terminal, Launchers, Open with, Dashboard,
  and Auto-commit — in that order.
- **This conception** (writes `.condash/settings.json`) carries
  Workspace & paths and Repositories — only what describes this tree.

Each section shows a **scope chip** naming the file it writes; there are
no inheritance badges or **Reset to global** buttons. There is no
in-modal JSON editor — each preference has its own form control. The
rail's **Open settings.json** / **Open .condash/settings.json** buttons
open either file with your OS default handler.

Full breakdown: the **Configuration** page in this same Help menu.

Per-tree config (`<conception>/.condash/settings.json`, with the legacy
`condash.json` / `configuration.json` read indefinitely as fallbacks) is
**per-host** by default — the `.condash/` directory is gitignored. Un-ignore
`.condash/settings.json` in your `.gitignore` to share workspace path,
repos, and launcher commands with teammates via git. Per-machine config
(`settings.json`) is local to this laptop — your editor binary, your
terminal, your theme.

## More

Full docs (tutorials, per-feature guides, reference) live online at
**https://condash.vcoeur.com**. The Help menu has an **Open documentation
site** entry.
