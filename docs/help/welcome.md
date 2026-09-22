# Welcome to condash

condash is a desktop dashboard for a folder of Markdown files. You write
projects, incidents, and documents as plain `.md` — condash gives you a
live view on top.

There is no database, no server, no account. Close condash and the files
are still on disk; delete condash and the files don't move.

## What a conception is

A **conception** is the folder condash renders: a plain directory of
Markdown projects and knowledge notes, usually a git repo. Everything you
see below — the panes, the terminal, the settings — is a live view over
that one folder.

## What you'll see

An **activity rail** runs down the left edge with the complete
navigation. **Projects** fills the left of the window with your items
as one scrolling stack of status sections (`now`, `review`, `later`,
`backlog`, `done`, plus a trailing `?` for any other status; drag a
card to another section to change its status). The other rail items
each select the one right-hand working pane — exactly one is ever
showing, and your choice is remembered:

- **Code** (`Ctrl+Shift+C`) — your repos, their branches, dirty
  counts, run / open-with buttons.
- **Knowledge** — your reference notes as cards.
- **Resources** — every file under `resources/` as cards, with copy /
  open / paste-to-term actions. Nothing to set up: drop a file in
  `resources/` and the pane surfaces it.
- **Skills** — the Markdown skills under `.agents/skills/`,
  read-only; hosts the five shipped skills — `/projects`,
  `/knowledge`, `/pr`, `/applications`, `/visual` — once
  `condash skills install` has run, with a Conception/User segmented
  control for user-scope sources.
- **Automations** — saved agent prompts you can run on demand or on a
  schedule.
- **Logs** — the per-session terminal capture viewer. Sessions are a
  collapsible card grid grouped by date; the viewer opens full-overlay
  with virtualised text + case-insensitive search. Turn capture on
  under Settings → Terminal → Logging.

The **View** menu mirrors the rail under **Working pane**, and carries
**Troubleshooting → Terminal diagnostics** (live per-terminal memory,
growth rate, and throttle state) alongside the Show Terminal toggle.

Across the bottom:

- **Terminal** — toggle with `` Ctrl+` ``. Real shells, one tab each.
- **Dashboard** — shares the bottom band with the
  terminal and summarises what each terminal tab is doing. Off by
  default; needs an API key.

And one modal:

- **Search** — `Ctrl+K` or `Ctrl+Shift+F` for full-text search across
  projects, knowledge, resources, skills, and (on request) logs.

## Changing the conception folder

**File → Open…** (`Ctrl+O`) opens the native folder picker.

**File → Open Recent** lists the last five trees you opened; picking one
switches immediately, with no dialog.

**File → Settings** (`Ctrl+,`) opens a single full-viewport modal — one
scrolling surface, no tabs — covering appearance, the embedded terminal,
launchers, auto-commit, and this conception's workspace paths and repos.

## Where to go next

This Help menu has the essentials, written to be read on their own:

- **Quick start** — install, first launch, your first project.
- **Keyboard shortcuts** — the few you'll use every day.
- **Configuration** — what the JSON files control.
- **CLI overview** — the `condash` command line.
- **Why Markdown-first** — the design pitch.

Full documentation lives at **https://condash.vcoeur.com**. The Help
menu has an **Open documentation site** entry that opens it in your
browser.
