---
name: applications
description: Manage the app registry — the single source of truth for `@handle` identity. List, register (add), update (set), rename (with README cascade), regenerate the AGENTS.md Apps table (sync-docs), and validate that every project README `apps:` reference resolves. Wraps `condash applications`. Also the canonical reference for how agents write `apps:` lists.
---

# /applications — the app registry + `@handle` conventions

Every app in this workspace has exactly one canonical **`@handle`** — the short, lowercase token that identifies it everywhere it is named. This skill manages the registry and is the reference for the conventions agents must follow when referencing apps.

## The one rule: reference apps by `@handle`

Anywhere an app is named — a project README `apps:` list, prose, a deliverable — use the `@handle`:

- **Registered app** → `@handle` (e.g. `@condash`, `@kasten`, `@alicepeintures`). The handle is what the coloured pill renders, in both the Projects pane and the Code pane, so the same app reads identically everywhere.
- **Unregistered repo outside the workspace** → an absolute path (`/home/me/src/other/Thing` or `~/src/other/Thing`). The only accepted non-handle form.
- **Never** a bare directory name (`condash`), a domain (`notes.vcoeur.com`), a label (`Kasten`), or a sub-path (`vcoeur.com/blog`). These are legacy forms — `validate` flags them and suggests the `@handle`.

In a YAML `apps:` list a `@`-prefixed value **must be quoted** (YAML reserves a leading `@`):

```yaml
apps:
  - "@condash"
  - "@kasten"
  - "~/src/sophie/RechercheAutoAO"   # unregistered, abs path
```

## Where identity lives

`condash.json › repositories[]` is the registry. Each entry: `handle` (defaults to the directory name when omitted), `label` (human title), `path` (location). Defunct handles that closed projects still reference live in `retired_apps` — valid for history, never rendered. Either may carry `aliases` (legacy spellings). Full schema: `docs/reference/config.md` in the condash repo.

The directory name and the label are **not** identities — only the handle is.

## Command surface

```
/applications <verb> [args]
```

| Verb | Trigger |
|------|---------|
| `list` | `/applications list` — every registered app (live + retired) |
| `add` | `/applications add <handle> --path <p> [--label <l>]` — register a new app |
| `set` | `/applications set <handle> [--label <l>] [--path <p>]` — update one |
| `rename` | `/applications rename <old> <new>` — rename a handle; cascades |
| `sync-docs` | `/applications sync-docs` — regenerate the AGENTS.md Apps table |
| `validate` | `/applications validate` — check every README `apps:` resolves |

Every verb shells out to `condash applications <verb>`. Pass `--json` for a machine envelope.

## Procedures

### list

```bash
condash applications list --json
```

Returns `[{handle, label, path, retired, aliases}]`. Use it to pick the right `@handle` before editing a README's `apps:`.

### validate

```bash
condash applications validate --json
```

Each issue is `{readme, ref, problem, suggestion?}`. `problem: "unknown-handle"` is a hard error (the verb exits 3) — the reference matches no live handle, no retired handle, and no existing path; fix the README or register the app. `problem: "alias"` is advisory — the value matched a legacy spelling; rewrite it to the suggested `@handle`. Run after any bulk README edit, and it is wired into the edit-time validation hook.

### sync-docs

```bash
condash applications sync-docs
```

Regenerates the Apps table inside **AGENTS.md** between the `<!-- condash:apps:start -->` / `<!-- condash:apps:end -->` sentinels from the registry. **AGENTS.md is the only source** — agent-specific files like CLAUDE.md are virtual, rendered from AGENTS.md by agedum at launch (never written to disk); never hand-edit them. If the verb reports `missingSentinels`, add the two sentinel comments around the existing Apps table once, then re-run. Run after any `add` / `set` / `rename`.

### add / set

```bash
condash applications add fovea --path fovea --label Fovea
condash applications set kasten --label "Kasten"
```

`add` fails if the handle (or an alias) already resolves. `<path>` is relative to `workspace_path` or absolute. After either, run `sync-docs`.

### rename

```bash
condash applications rename fovea fovea-web
```

Cascades: updates the registry entry, records the old handle as an `alias`, and rewrites every project README `apps:` reference that resolved to the old handle. Report the count of rewritten READMEs to the user, then run `sync-docs`.

## Rules

- **Handle is the only identity.** Never introduce a second way to reference an app. If a name reads badly as a pill, change its `handle`/`label` — don't reference it a different way.
- **`@` values are quoted in YAML.** Unquoted `- @foo` fails to parse and silently drops from `apps:`.
- **Never write CLAUDE.md.** `sync-docs` targets AGENTS.md; agedum renders the harness view virtually at launch.
- **A handle is live or retired, never both.** Promote a retired handle back by moving it from `retired_apps` to `repositories[]` (or use `add`).
- **Validate before you ship** a project that touched `apps:` — an unresolved reference exits 3 and blocks the edit-time hook.
