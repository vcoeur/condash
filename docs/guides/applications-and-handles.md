---
title: Applications and handles · condash guide
description: How condash identifies each app by one canonical #handle, where the registry lives, and how to manage it from the CLI.
---

# Applications and handles

> **Audience.** Daily user managing more than one repo.

**When to read this.** A project README's `apps:` value shows up wrong on the card, you renamed a repo and old references broke, or you're adding a new app and want it to read consistently everywhere.

## One app, one `#handle`

Every app condash knows about has exactly one canonical **`#handle`** — a short, lowercase token (`#condash`, `#kasten`, `#painting-manager`). The handle is the single identity used in:

- the coloured pill on Code-pane and project cards (always rendered as `#handle`, coloured by a stable hash of the handle),
- a project README's `apps:` list,
- the generated Apps table in `AGENTS.md`,
- cross-tree search.

!!! note "The sigil is `#`, not `@`"
    Earlier versions used `@handle`. condash switched to `#` in v4.8.0 because a leading `@` triggers file-path autocompletion in agent CLIs, which mangled handles mid-prompt; `#` is unbound. A stray `@`-prefixed value no longer resolves and `validate` flags it. In a YAML `apps:` list a `#` value **must be quoted** (an unquoted leading `#` is a YAML comment):

    ```yaml
    apps:
      - "#condash"
      - "#kasten"
      - "~/src/other/Thing"   # unregistered repo → absolute path
    ```

## Where the registry lives

The registry is your config's **`repositories[]`** array (`settings.json` defaults, overridable per tree in `.condash/settings.json`). Each entry's `handle` defaults to the directory name — sigil-stripped and lowercased — so simple repos need set nothing. Domain-style or camelCase repos should pin one explicitly:

```json
{
  "repositories": [
    "condash",
    { "handle": "kasten", "path": "notes.vcoeur.com" },
    { "handle": "painting-manager", "path": "PaintingManager", "aliases": ["PaintingManager"] }
  ]
}
```

- **`handle`** — the canonical identity. Omit it and you get `appHandle(name)` (directory name, sigil-stripped + lowercased).
- **`aliases`** — legacy spellings that still resolve to this handle. `validate` flags a README `apps:` value matching an alias and suggests the `#handle` rewrite; `rename` records the old handle here for you.
- **`label`** — an optional human title rendered as a secondary subtitle; the primary pill is always the `#handle`.
- **`submodules`** — nested repo entries are apps in their own right: each gets a handle by the same rules and resolves everywhere a handle is expected (a project may depend on a single submodule of a repo). `list` and the generated Apps table render them under their parent, prefixed `↳`.

### Retired apps

A repo that no longer exists but is still referenced by closed-project READMEs goes in the top-level **`retired_apps`** list:

```json
{ "retired_apps": [{ "handle": "kasten-manager", "label": "KastenManager", "aliases": ["KastenManager"] }] }
```

Retired handles **resolve** (so history stays valid) but are never rendered as cards and never appear in the generated Apps table. A handle is either live (in `repositories`) or retired (here) — never both.

## How `apps:` values resolve

A project README's `apps:` entry must be one of:

- a live `#handle` (in `repositories` — top-level or submodule),
- a retired `#handle` (in `retired_apps`),
- or an absolute path to an unregistered repo outside the workspace (`~/src/other/Thing`).

A bare directory name, a domain (`notes.vcoeur.com`), a label, or a sub-path are **legacy forms** — `condash applications validate` flags each and suggests the canonical `#handle`.

## Managing it from the CLI

```bash
condash applications list                # every app, live + retired
condash applications add fovea --path fovea --label "Fovea"
condash applications set kasten --label "Kasten"
condash applications rename fovea fovea-web   # cascades into README apps: refs
condash applications validate            # exit 3 on an unresolved reference
condash applications validate --fix      # canonicalise every resolvable value
condash applications sync-docs           # regenerate the AGENTS.md Apps table
```

| Verb | What it does |
|------|--------------|
| `list` | List every registered app (live + retired) with handle, label, path; submodules render indented under their parent (`↳ #child`). |
| `add <handle> --path <p> [--label <l>]` | Register a new live app. |
| `set <handle> [--label <l>] [--path <p>]` | Update a registered app. |
| `rename <old> <new>` | Rename a handle; records the old as an alias **and** rewrites every project README `apps:` reference that pointed at it. |
| `sync-docs` | Regenerate the Apps table in `AGENTS.md` between the `condash:apps` sentinels from the registry. (Agent-specific files like `CLAUDE.md` are virtual renders of `AGENTS.md` and are never written to disk.) |
| `validate [--fix]` | Check every README `apps:` value resolves to a known `#handle` or existing path. `--fix` canonicalises every resolvable value (bare names and aliases alike), leaving only the unresolvable ones for a human. |

→ Schema details for `repositories[]` and `retired_apps` are in **[Config files → repositories](../reference/config.md#repositories)**. The full CLI surface is in **[CLI → applications](../reference/cli.md#applications)**. How handles read inside an `AGENTS.md` `## Specifics` section: **[AGENTS.md style guide](../reference/agents-md-style.md)**.
