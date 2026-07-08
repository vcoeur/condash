---
title: Mutation model · condash reference
description: The exhaustive list of every action the dashboard takes on your files — and everything it deliberately never touches.
---

# Mutation model

> **Audience.** Daily user and Developer.

## At a glance

The dashboard's **write surface is small**. It touches three places only:

1. An item's `README.md` (step + status edits).
2. Files under an item's root, mostly the `notes/` subdirectory (create, rename, upload, overwrite).
3. The tree-level `<conception_path>/.condash/settings.json` (canonical write target; legacy `condash.json` and `configuration.json` are read but not written).

It does **not** touch `.git/`, does not move or rename item directories, does not run shell commands other than the user-configured `open_with.*` / `pdf_viewer` / `terminal.launchers[].command` chains and the `repositories[].run` / `force_stop` strings.

Every mutation is exposed as an [IPC verb](ipc-api.md) on the `CondashApi` interface in [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts). If a verb isn't listed here, condash doesn't write.

## README edits

All operate on the item's `README.md` in place. Paths are validated against the conception tree before any I/O — the path helpers reject `..` traversal and symlinks that escape the root.

| Action | IPC verb | Trigger | Effect on `README.md` |
|---|---|---|---|
| Toggle step | `toggleStep` | Click a checkbox | Rewrites one `- [<marker>] <text>` line. Drift-checked: `expectedMarker` must match the on-disk marker or the write is refused. Markers are `[ ]`, `[~]`, `[x]`, `[-]`. |
| Add step | `addStep` | Click "+" in the Steps section | Inserts `- [ ] <text>` at the end of the `## Steps` section |
| Edit step | `editStepText` | Click the pencil on a step | Rewrites the `<text>` portion. Drift-checked: `expectedText` must match the on-disk text. |
| Change status | `setStatus` | Drag card between kanban columns | Rewrites the status line in the metadata block — `status: <value>` for YAML-frontmatter READMEs, `**Status**: <value>` for the legacy bold-prose form. On done-edges (close: prev → done, reopen: done → prev) also appends a `Closed.` / `Reopened.` line to `## Timeline`. Refuses if no status line is present. |
| Create item | `createProject` | Submit the new-project modal | Allocates `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/` from the canonical kind template (project / incident / document) and writes the README. |

All mutation verbs are routed through [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts), which:

- Validates the path is inside the resolved conception path.
- Acquires the per-file write queue (`withFileQueue`) so concurrent toggles on the same file never interleave.
- Performs the drift check (compare the expected marker / text / content against what's on disk).
- Writes via `tmp` → `fsync` → `rename`.

If the drift check fails, the renderer surfaces a "reload before saving" toast and the user re-opens the file.

## Notes and attachments

All paths live under an item's directory (`projects/YYYY-MM/YYYY-MM-DD-slug/...`). The `notes/` subdirectory is the conventional home.

| Action | IPC verb | Trigger | Effect |
|---|---|---|---|
| Read a note | `readNote` | Click a file in the card | Returns plain bytes — no write |
| Overwrite a note | `writeNote` | Save in the note editor | Atomic rewrite via `.tmp` + rename. Full-content drift check refuses stale overwrites. For `.condash/settings.json` (or the legacy `condash.json`), the bytes written may differ from the input (Zod canonicalisation reorders keys). |
| Create a note | `createProjectNote` | Click "+ Note" in the card | Creates `<projectPath>/notes/NN-<slug>.md` with the next zero-padded counter; returns the new path. |
| List item files | `listProjectFiles` | Open the notes panel | Lists files under the item's `notes/` directory — no write |

The `writeNote` verb takes `(path, expectedContent, newContent)`. If `expectedContent` no longer matches what's on disk, the renderer surfaces a "reload before saving" toast and the write is refused. No merge — the user re-opens the note and redoes their edit.

## Config edits

The tree-level `<conception_path>/.condash/settings.json` is editable through the gear modal's plain-text JSON editor (legacy `condash.json` / `configuration.json` are read but never written). The dashboard does not expose a typed config API — the user edits the JSON directly, and condash reparses on save.

The watcher fires a `config` event on `tree-events`, the renderer bumps `refreshKey`, and most changes reload live. Structural changes (`workspace_path`, `worktrees_path`, the `repositories` list shape) require a restart for paths to be re-resolved.

`settings.json` (per-user, per-machine — `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`) is partially written by the IPC layer: `pickConceptionPath`, `setTheme`, `setLayout`, `setWelcomeDismissed`, and `termSetPrefs` each touch a single narrow key (`lastConceptionPath`, `theme`, `layout`, `welcome.dismissed`, `terminal`). Anything else still needs a hand-edit; condash reads the file on the next launch.

See [Config files](config.md) for the full key schema and which file owns which key.

## Open-with / external-launch commands

The launcher verbs spawn an external process. These **do not** write to the conception tree — they spawn a command with `{path}` substituted in — but they're listed here because the sandbox rules matter.

| Action | IPC verb | Accepted path | Command run |
|---|---|---|---|
| Open in IDE / terminal | `launchOpenWith(slot, path)` | Must resolve under `workspace_path` **or** `worktrees_path` | The `open_with.<slot>.command` template, with `{path}` substituted at the argv level (no shell expansion) |
| Open in editor | `openInEditor(path)` | Must resolve under the resolved conception path | The configured editor (or the OS default for non-text files) |
| Open conception root | `openConceptionDirectory()` | Always the resolved conception path | OS default file manager |
| Open a local path | `openPath(target)` | Absolute path, OS-validated | OS default handler — used by the Settings modal "Open externally" buttons |
| Open an external URL | `openExternal(target)` | Scheme must be `http:`, `https:`, or `mailto:` | OS default handler |
| Force-stop a repo | `forceStopRepo(repoName)` | Repo must be in the conception's `repositories` (resolved from `.condash/settings.json` or the legacy `condash.json`) | The repo's `force_stop:` shell command — no path argument |

Paths outside the configured sandbox are rejected **before the shell sees them**. The validation lives in [`src/main/launchers.ts`](https://github.com/vcoeur/condash/blob/main/src/main/launchers.ts) (path checks) and the per-verb handlers in [`src/main/index.ts`](https://github.com/vcoeur/condash/blob/main/src/main/index.ts).

The embedded terminal (`termSpawn`) takes a `cwd` field that goes through the same path-validation check, so a spawned shell can only start inside `workspace_path` or `worktrees_path`.

## What the dashboard never writes

| Never | Why |
|---|---|
| Anything under `.git/` | Out of scope. Use your editor / CLI. |
| Anything outside the resolved conception path | Path validation rejects escapes. |
| Item directory renames / moves | The flat-month layout means items stay put for life; slug / date changes need `git mv` in the user's shell. |
| `knowledge/` tree | Read-only from the dashboard. Edit in your editor (or via the `/knowledge` skill). |
| Caches or indices | Read-side only. An mtime-keyed `parseReadme` memo (`src/main/parse-cache.ts`) skips re-parsing unchanged READMEs, and the in-memory search index — both kept fresh by chokidar (invalidated on change/unlink). Plus an mtime+size-keyed `settings.json` read memo (`src/main/settings.ts`), invalidated on every write through the settings queue. Writes always hit disk. |
| Lock files | Concurrent edits are detected via the drift check on `toggleStep` / `editStepText` / `writeNote`; there's no advisory lock. |

## Skill-invoked edits

The [`/projects` and `/knowledge`](skill.md) management skills invoke plain file operations from a Claude Code session — they do not call any IPC verbs. Their mutations are therefore out of scope of this page; treat them as "edits made in your editor, from the outside". The chokidar watcher picks up the changes either way and the renderer re-renders the affected items.

## Concurrency

Every write is atomic at the OS level (`.tmp` file + `rename` after `fsync`). Concurrency between the dashboard and an external editor is handled by the drift check on `toggleStep` / `editStepText` / `writeNote`: if the on-disk content doesn't match the renderer's snapshot, the write is refused and the UI surfaces a conflict banner. No merge — the user re-opens the file and redoes their edit.

Concurrent writes from within condash are serialised by the per-file write queue in [`mutate.ts:withFileQueue`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) — concurrent toggles on the same file never interleave, and a failure in one write doesn't poison the queue.
