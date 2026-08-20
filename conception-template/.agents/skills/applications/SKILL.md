---
name: applications
description: Manage the app registry — the single source of truth for `#handle` identity. List, register (add), update (set), rename (with README cascade), regenerate the AGENTS.md Apps table (sync-docs), and validate that every project README `apps:` reference resolves. Wraps `condash applications`. Also the canonical reference for how agents write `apps:` lists.
---

# /applications — the app registry + `#handle` conventions

Every app in this workspace has exactly one canonical **`#handle`** — the short, lowercase token that identifies it everywhere it is named. This skill manages the registry and is the reference for the conventions agents must follow when referencing apps.

## The one rule: one canonical name per app

Every app has exactly one canonical handle. In prose, in a deliverable, in anything a reader
sees, write it as `#handle` (e.g. `#app-one`) — that is what the coloured pill renders in both
the Projects pane and the Code pane, so the same app reads identically everywhere.

In a project README `apps:` list, the handle is the value, and the `#` is optional: the
resolver strips a leading `#`, lowercases, and reduces a path to its last segment, so both
forms hit the same registry entry.

```yaml
apps:
  - app-one                          # the handle, bare — the common form
  - "#app-two"                       # identical after resolution; the leading # needs quotes
  - "~/src/other/Thing"              # unregistered repo outside the workspace, abs path
```

- **Prefer the bare handle in `apps:`.** An unquoted leading `#` is read as a YAML comment, so
  the `#` form must be quoted and buys nothing the resolver does not already do.
- **Unregistered repo outside the workspace** → an absolute path (`/home/me/src/other/Thing`
  or `~/src/other/Thing`). The only accepted value that is not a registry name.
- **Never a name the registry does not know** — a domain, a human label, or a sub-path that is
  not itself the handle. `validate` reports a declared legacy spelling as `problem: "alias"`
  with the current handle to use, and anything it cannot resolve at all as
  `problem: "unknown-handle"`, which is a hard error.

## Where identity lives

`.condash/settings.json › repositories[]` is the registry. Each entry: `handle` (defaults to the directory name when omitted), `label` (human title), `purpose` (one line on what the app is for — the generated Apps table's Purpose column), `path` (location). Defunct handles that closed projects still reference live in `retired_apps` — valid for history, never rendered. Either may carry `aliases` (legacy spellings). Full schema: `docs/reference/config.md` in the condash repo.

The directory name and the label are **not** identities — only the handle is.

## Command surface

```
/applications <verb> [args]
```

| Verb | Trigger |
|------|---------|
| `list` | `/applications list` — every registered app (live + retired) |
| `add` | `/applications add <handle> --path <p> [--label <l>] [--purpose <text>]` — register a new app |
| `set` | `/applications set <handle> [--label <l>] [--purpose <text>] [--path <p>]` — update one; any handle `list` shows, submodules included |
| `rename` | `/applications rename <old> <new>` — rename a handle; cascades; submodules included |
| `sync-docs` | `/applications sync-docs` — regenerate the AGENTS.md Apps table |
| `validate` | `/applications validate` — check every README `apps:` resolves |

Every verb shells out to `condash applications <verb>`. Pass `--json` for a machine envelope.

## Procedures

### list

```bash
condash applications list --json
```

Returns `[{handle, label, purpose, path, retired, aliases}]`. Use it to pick the right `#handle` before editing a README's `apps:`.

### validate

```bash
condash applications validate --json
```

Each issue is `{readme, ref, problem, suggestion?}`. `problem: "unknown-handle"` is a hard error (the verb exits 3) — the reference matches no live handle, no retired handle, and no existing path; fix the README or register the app. `problem: "alias"` is advisory — the value matched a legacy spelling; rewrite it to the suggested `#handle`. Run after any bulk README edit, and it is wired into the edit-time validation hook.

### sync-docs

```bash
condash applications sync-docs
```

Regenerates the Apps table inside **AGENTS.md** between the `<!-- condash:apps:start -->` / `<!-- condash:apps:end -->` sentinels from the registry — App, Repo, Purpose, AGENTS.md, Knowledge. The whole region is rewritten, so a column or a companion table added by hand is erased on the next run: put the one-line description in the registry's `purpose` instead. **AGENTS.md is the only source** — agent-specific files like CLAUDE.md are virtual, rendered from AGENTS.md by agedum at launch (never written to disk); never hand-edit them. If the verb reports `missingSentinels`, add the two sentinel comments around the existing Apps table once, then re-run. Run after any `add` / `set` / `rename`.

### add / set

```bash
condash applications add fovea --path fovea --label Fovea --purpose "Screenshot diffing service"
condash applications set kasten --label "Kasten"
condash applications set kasten --purpose "Zettelkasten vault and web UI"
```

`add` fails if the handle (or an alias) already resolves. `<path>` is relative to `workspace_path` or absolute. After either, run `sync-docs`.

### rename

```bash
condash applications rename fovea fovea-web
```

Cascades: updates the registry entry, records the old handle as an `alias`, and rewrites every project README `apps:` reference that resolved to the old handle. Report the count of rewritten READMEs to the user, then run `sync-docs`.

## Rules

- **Handle is the only identity.** Never introduce a second way to reference an app. If a name reads badly as a pill, change its `handle`/`label` — don't reference it a different way.
- **`#` values are quoted in YAML.** An unquoted `- #foo` is read as a comment and silently drops from `apps:`.
- **Never write CLAUDE.md.** `sync-docs` targets AGENTS.md; agedum renders the harness view virtually at launch.
- **A handle is live or retired, never both.** Promote a retired handle back by moving it from `retired_apps` to `repositories[]` (or use `add`).
- **Validate before you ship** a project that touched `apps:` — an unresolved reference exits 3 and blocks the edit-time hook.
