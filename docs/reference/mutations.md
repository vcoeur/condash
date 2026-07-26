---
title: Mutation model · condash reference
description: The exhaustive list of every action the dashboard takes on your files — and everything it deliberately never touches.
---

# Mutation model

> **Audience.** Daily user and Developer.

## At a glance

Every mutation the dashboard performs is exposed as an [IPC verb](ipc-api.md) on the `CondashApi` interface in [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts). If a verb isn't listed here, condash doesn't write.

**Content you author** — the surface you actually think about:

- An item's `README.md` (step + status edits).
- Files under an item's root, mostly the `notes/` subdirectory (create, overwrite).
- The `knowledge/` and `resources/` trees (new file, new folder, import).
- Task definitions at `<conception>/tasks/<slug>/`.

**Config** — one file each, by key ([which owns what](config.md#all-config-keys)):

- `<conception>/.condash/settings.json` — the tree's paths, repos, retired handles, task config. (Legacy `condash.json` / `configuration.json` are read but never written; the auto-migrator tombstones them and appends `.condash/` to the conception's `.gitignore` on first open.)
- The per-machine `settings.json` — everything personal.

**Machine-generated state**, all under the gitignored `.condash/` and never edited by hand:

- `.condash/logs/YYYY/MM/DD/` — terminal session transcripts, when `terminal.logging.enabled`.
- `.condash/{scheduled,manual}/<slug>/` — the segregated task-run store.
- `.condash/dashboard/state.json` — per-tab summaries + rolling history.
- `.condash/perf/YYYY-MM-DD.jsonl` — perf records, when `terminal.perf.enabled`.
- `.condash/transcripts/<sid>.ndjson` — the per-tab in-band agent transcript sidecar.
- `.condash/cache/readme-parse.json` — the CLI's mtime-keyed README parse cache.

One write lands **outside** the tree entirely: `exportNotePdf` writes wherever the OS save dialog puts it.

It does **not** touch `.git/`, and does not move or rename item directories. The only shell commands it runs are ones you configured: the `open_with.*` / `pdf_viewer` chains, the `agents[].command` launchers, and `repositories[].run` / `force_stop`.

## README edits

All operate on the item's `README.md` in place. Paths are validated against the conception tree before any I/O — the path helpers reject `..` traversal and symlinks that escape the root.

| Action | IPC verb | Trigger | Effect on `README.md` |
|---|---|---|---|
| Toggle step | `toggleStep` | Click a checkbox | Rewrites one `- [<marker>] <text>` line. Drift-checked: `expectedMarker` must match the on-disk marker or the write is refused. The five markers are `[ ]`, `[~]`, `[x]`, `[!]`, `[-]`; the click cycle covers four of them (`[!]` is set by editing the README). See [Step markers](readme-format.md#step-markers). |
| Add step | `addStep` | Click "+" in the Steps section | Inserts `- [ ] <text>` at the end of the `## Steps` section |
| Edit step | `editStepText` | Click the pencil on a step | Rewrites the `<text>` portion. Drift-checked: `expectedText` must match the on-disk text. |
| Change status | `setStatus` | Drag a card between status groups (the pane is one vertical stack, not kanban columns) | Rewrites the status line in the metadata block — `status: <value>` for YAML-frontmatter READMEs, `**Status**: <value>` for the legacy bold-prose form. On done-edges (close: prev → done, reopen: done → prev) also appends a `Closed.` / `Reopened.` line to `## Timeline`. Refuses if no status line is present. |
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
| Create a file | `createProjectFile` | "New file" in the preview's file tree (root buttons or a dir's hover "+") | Creates an empty file with the given name inside the chosen project subdirectory. Refuses existing targets, names with path separators / leading or trailing dots, and Windows reserved device names; the target is realpath-bounded to a real item directory (`projects/<month>/<dated-slug>/`). |
| Create a folder | `createProjectDir` | "New folder" in the preview's file tree | Same bounding and name rules as `createProjectFile`; non-recursive `mkdir`, so an existing entry (symlinks included) is refused. |
| List item files | `listProjectFiles` | Open the item's preview popup | Lists the item directory's files **and** directories recursively (`kind` distinguishes them) — no write. Feeds the popup's collapsible file tree. |

The `writeNote` verb takes `(path, expectedContent, newContent)`. If `expectedContent` no longer matches what's on disk, the renderer surfaces a "reload before saving" toast and the write is refused. No merge — the user re-opens the note and redoes their edit.

## Config edits

**There is no in-modal JSON editor.** **File → Settings** is one scrolling surface of typed form controls; each section stages a draft and **Save** flushes it through an atomic CAS write — `writeGlobalSettings` for `settings.json`, `writeNote` for `.condash/settings.json` — schema-validated by the strict zod schemas before the bytes hit disk. The rail also carries **Open settings.json** / **Open .condash/settings.json** buttons if you'd rather hand-edit in your own editor. See [Editing from the dashboard](config.md#editing-from-the-dashboard) for the section list. Legacy `condash.json` / `configuration.json` are read but never written.

Beyond the modal, these verbs each write one narrow key of the per-machine `settings.json`:

| Verb | Key it touches |
|---|---|
| `pickConceptionPath`, `openConception` | `lastConceptionPath` + `recentConceptionPaths` |
| `clearRecentConceptionPaths`, `removeRecentConceptionPath` | `recentConceptionPaths` |
| `setTheme` | `theme` |
| `setLayout` | `layout` |
| `setWelcomeDismissed` | `welcome.dismissed` |
| `setCardMinWidth` | `cardMinWidth` |
| `setTreeExpansion` | `treeExpansion` |
| `setSelectedBranches` | `selectedBranches` |
| `setBranchFilterStickyAll` | `branchFilterStickyAll` |
| `setSkillsActiveScope` | `skillsActiveScope` |
| `termSetPrefs` | `terminal` (full-block replacement) |
| `perfSetEnabled` | `terminal.perf.enabled` (merged over the current block) |
| `writeGlobalSettings` | the whole file, CAS-checked |

On the conception side, `setTaskConfig` writes one slug's entry into `taskConfig`; the modal's **Workspace & paths** and **Repositories** sections write the rest.

A `.condash/settings.json` change fires a `config` event on `tree-events`, the renderer bumps `refreshKey`, and most changes reload live. The per-machine `settings.json` lives outside the conception, so the watcher never sees it — a hand-edit there is picked up on the next conception open, not immediately. Structural changes (`workspace_path`, `worktrees_path`, the `repositories` list shape) require a restart for paths to be re-resolved either way.

See [Config files](config.md) for the full key schema and which file owns which key.

## Knowledge, Resources, and tasks

| Action | IPC verb | Effect |
|---|---|---|
| New file | `treeCreateMd(root, dirRelPath, filename)` | Creates an empty file under `knowledge/` or `resources/`. The stem is slugified; knowledge forces `.md`, resources keep a supplied extension and default to `.md`. Refuses to overwrite. |
| New folder | `treeMkdir(root, dirRelPath, name)` | Creates a subdirectory under the same two roots. Idempotent for a plain directory; refuses when the target already exists as a symlink. |
| Import a file | `treeImportFile(root, dirRelPath)` | OS file picker, then copy into the target directory. Refuses to overwrite. The usual route for dropping a PDF or image into Resources. |
| Write a task | `writeTask(slug, def, previousSlug?)` | Creates or updates `<conception>/tasks/<slug>/` (`task.json` + `prompt.md`). A differing `previousSlug` removes the old directory — the rename path. |
| Delete a task | `deleteTask(slug)` | Removes a task directory. |

All three `tree*` verbs normalise `dirRelPath` and then re-check the joined result is still under the pane's root, so a `..` segment or an absolute path from the renderer cannot escape it. **`root === 'skills'` is rejected outright** — the Skills pane is read-only, because agedum owns that source of truth.

## Machine-generated state

These write on their own schedule, without a user action, and all live under the gitignored `.condash/`. They are listed for completeness — nothing here is meant to be read or edited by hand, and deleting any of it is safe.

| Path | Written when | Deleted by |
|---|---|---|
| `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt` | `terminal.logging.enabled` — one file per pty session | `logsDeleteDay` / `logsDeleteSession`, plus the in-app janitor's retention caps |
| `.condash/{scheduled,manual}/<slug>/` | Every scheduled task run, and a manual run of a task flagged `excludeFromLogs` | Manually; the Logs pane's **Task runs** view reads it |
| `.condash/dashboard/state.json` | Each dashboard engine cycle | Manually |
| `.condash/perf/YYYY-MM-DD.jsonl` | `terminal.perf.enabled` | The perf janitor's caps |
| `.condash/transcripts/<sid>.ndjson` | A cooperating agent appends in-band transcript frames for its tab | Manually |
| `.condash/cache/readme-parse.json` | Every CLI invocation that parses READMEs | Manually; regenerated on the next run |

One more write is not a mutation of the tree at all: `exportNotePdf` renders a note through `printToPDF` in a hidden window and saves it wherever the OS dialog puts it — possibly outside the conception entirely.

## Open-with / external-launch commands

The launcher verbs spawn an external process. These **do not** write to the conception tree — they spawn a command with `{path}` substituted in — but they're listed here because the sandbox rules matter.

| Action | IPC verb | Accepted path | Command run |
|---|---|---|---|
| Open in IDE / terminal | `launchOpenWith(slot, path)` | Must resolve under `workspace_path` **or** `worktrees_path` | The `open_with.<slot>.command` template, with `{path}` substituted at the argv level (no shell expansion) |
| Open in editor | `openInEditor(path)` | Must resolve under the resolved conception path | The configured editor (or the OS default for non-text files) |
| Open conception root | `openConceptionDirectory()` | Always the resolved conception path | OS default file manager |
| Open a local path | `openPath(target)` | Absolute path, OS-validated | OS default handler — used by the Settings modal "Open externally" buttons |
| Open an external URL | `openExternal(target)` | Scheme must be `http:`, `https:`, or `mailto:` | OS default handler |
| Force-stop a repo | `forceStopRepo(repoName)` | Repo must be in the conception's `repositories` (resolved from `.condash/settings.json` or the legacy `condash.json`) | The repo's `force_stop:` command, argv-split and spawned directly (no shell) — no path argument |

Paths outside the configured sandbox are rejected **before the shell sees them**. The validation lives in [`src/main/launchers.ts`](https://github.com/vcoeur/condash/blob/main/src/main/launchers.ts) (path checks) and the per-verb handlers in [`src/main/index.ts`](https://github.com/vcoeur/condash/blob/main/src/main/index.ts).

The embedded terminal (`termSpawn`) takes a `cwd` field that goes through the same path-validation check, so a spawned shell can only start inside `workspace_path` or `worktrees_path`.

## What the dashboard never writes

| Never | Why |
|---|---|
| Anything under `.git/` | Out of scope. Use your editor / CLI. |
| Anything outside the resolved conception path | Path validation rejects escapes. |
| Item directory renames / moves | The flat-month layout means items stay put for life; slug / date changes need `git mv` in the user's shell. |
| Existing files under `knowledge/` or `resources/` | The tree panes **create** files and folders and **import** files (above), but never rewrite an existing one — every create refuses an occupied target. Editing a knowledge body is your editor's job, or the `/knowledge` skill's. |
| Anything under `.agents/skills/` | The Skills pane is read-only in both scopes; agedum owns those sources. `condash skills install` (a CLI verb, not a dashboard action) is the only writer. |
| Lock files | Concurrent edits are detected via the drift check on `toggleStep` / `editStepText` / `writeNote`; there's no advisory lock. |

**Caches are a partial exception.** Three are memory-only and read-side: the mtime-keyed `parseReadme` memo (`src/main/parse-cache.ts`), the in-memory search index (both kept fresh by chokidar, invalidated on change / unlink), and an mtime+size-keyed `settings.json` read memo (`src/main/settings.ts`), invalidated on every write through the settings queue. The CLI's `.condash/cache/readme-parse.json` is the one that touches disk — see [Machine-generated state](#machine-generated-state). Content writes always hit disk regardless; nothing is buffered behind a cache.

## Skill-invoked edits

The [shipped management skills](skill.md) drive the `condash` CLI and plain file operations from a Claude Code session — they never call an IPC verb. Their mutations are therefore out of scope of this page; treat them as "edits made in your editor, from the outside". The chokidar watcher picks up the changes either way and the renderer re-renders the affected items.

## Concurrency

Every write is atomic at the OS level (`.tmp` file + `rename` after `fsync`). Concurrency between the dashboard and an external editor is handled by the drift check on `toggleStep` / `editStepText` / `writeNote`: if the on-disk content doesn't match the renderer's snapshot, the write is refused and the UI surfaces a conflict banner. No merge — the user re-opens the file and redoes their edit.

Concurrent writes from within condash are serialised by the per-file write queue in [`mutate.ts:withFileQueue`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) — concurrent toggles on the same file never interleave, and a failure in one write doesn't poison the queue.
