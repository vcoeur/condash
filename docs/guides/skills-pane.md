# The Skills pane

The Skills pane sits alongside **Code**, **Knowledge**, and **Resources** in the right working-surface slot (`Ctrl+L` to switch in). Its header has two rows: a **Local / Global** scope toggle (with a refresh button on the right), and below it a tab bar selecting one of four trees — **Generic** (agent-neutral source skillspecs plus the `common.md` / `<model>.md` agent-config sources), **Claude**, **Kimi**, and **OpenCode** (each agent's compiled skills + config). The pane is **read-only**: it surfaces skills and agent configs for browsing. Edit them at their source and re-run `condash skills install` to regenerate.

![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-light.png#only-light)
![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-dark.png#only-dark)

## Scope: Local vs Global

The first header row toggles which scope the pane reads:

- **Local** (default) — the active conception's skills + agent configs.
- **Global** — the per-machine user scope that `condash skills install --user` lays down, under `~/.config/agents/`, `~/.claude/`, `~/.kimi/`, and `~/.config/opencode/`.

The selected scope is remembered per-machine in `settings.json` (`skillsActiveScope`); flipping it re-reads the active tab's tree. The **refresh** button on the right of the scope row re-reads the current tree on demand — useful in the Global scope, whose paths aren't watched for changes the way the conception tree is.

## The four tabs

Each tab reads a skills directory plus the agent-config files for that tab, prepended at the top as read-only callouts:

| Tab | Local reads | Global reads | Config callouts |
|---|---|---|---|
| **Generic** | `<conception>/.agents/skills/` | `~/.config/agents/skills/` | `common.md` + `claude.md` / `kimi.md` / `opencode.md` from the matching `…/agents/agents/` |
| **Claude** | `<conception>/<skills_path>` (default `.claude/skills/`) | `~/.claude/skills/` | the compiled `CLAUDE.md` |
| **Kimi** | `<conception>/.kimi/skills/` | `~/.kimi/skills/` | `AGENTS.md` (local + global) |
| **OpenCode** | `<conception>/.opencode/skills/` | `~/.config/opencode/skills/` | `AGENTS.md` |

The currently-selected tab is remembered per-machine in `settings.json` (`skillsActiveTab`), so the next launch reopens the same view. The first launch after the tabs ship defaults to **Claude** to match the pre-tabs behaviour.

Each tab maintains its own directory expansion state and scroll position. Switching tabs within a scope is paint-only — all four trees are loaded eagerly when a conception is opened (and re-fetched on a scope flip or refresh).

## What each tab shows

### Generic (sources)

The Generic tab walks the skills root and surfaces both `.md` and `.yaml` files:

- `body.md` and sibling markdown files (`index.md`, `retrieve.md`, …) render as standard cards. Title is pulled from the first H1.
- `spec.yaml` and `targets/<agent>.yaml` render as cards with a `YAML` badge — title falls back to the filename when no H1 is present (YAML has none).

Above the tree, the agent-config **sources** render as read-only callouts: `common.md` (the shared base) and each present `<model>.md` overlay (`claude.md`, `kimi.md`, `opencode.md`), badged by name (`COMMON`, `CLAUDE`, …). These are the inputs `condash skills install` splices into each agent's compiled `CLAUDE.md` / `AGENTS.md` — there is no single "generic" compiled config, so the Generic tab shows the sources instead.

### Claude (compiled)

- Each subdirectory under the skills root is treated as a skill — its `SKILL.md` renders as a badged callout at the top of the expanded body.
- Body files render as cards underneath. The walker recurses to any depth.
- The compiled `CLAUDE.md` is surfaced at the root with a `CLAUDE` badge (`<conception>/CLAUDE.md` + `<conception>/.claude/CLAUDE.md` locally; `~/.claude/CLAUDE.md` globally).

### Kimi (compiled)

Same layout as Claude, rooted at the Kimi skills dir. The config callout is `AGENTS.md` (badged `KIMI`) — `<conception>/.kimi/AGENTS.md` locally and `~/.kimi/AGENTS.md` globally. Kimi doesn't read these natively; the condash kimi agent wraps the file into a transient `--agent-file` (`ROLE_ADDITIONAL`) at launch.

### OpenCode (compiled)

Same layout as Kimi, rooted at the OpenCode skills dir, with an `AGENTS.md` config callout.

**Telling OpenCode to read condash's config.** condash compiles the conception's agent config to `.opencode/AGENTS.md` (project scope) and `~/.config/opencode/AGENTS.md` (user scope, with `--user`). OpenCode reads the global `~/.config/opencode/AGENTS.md` automatically. It does **not** auto-discover the project-scope `.opencode/AGENTS.md` (condash never touches the conception-root `AGENTS.md`, which it manages separately), so point OpenCode at it from the project's `opencode.json`:

```json
{ "instructions": [".opencode/AGENTS.md"] }
```

Skills need no such step — OpenCode discovers `.opencode/skills/` (and `~/.config/opencode/skills/`) on its own. But OpenCode *also* scans `.claude/skills/` and `.agents/skills/`, and resolves a duplicate skill name by a non-deterministic race (no stable precedence), so run OpenCode with `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` to have it read only its own dirs and treat condash's `.opencode/` output as the single source.

## Viewing files

Click any card or config callout to open the file in the note modal — the same viewer used elsewhere in condash, opened **read-only**. Wikilinks and relative markdown links route through the in-modal navigator just like Knowledge files. Global-scope files live outside the conception, so the pane reads them through a dedicated `readSkillFile` IPC bounded to the user-scope skill + agent-config locations (never their parent dirs).

The pane never writes. To change a skill or agent rule, edit it at its source — a skillspec under `.agents/skills/`, or an agent-config source under `.agents/agents/` (`~/.config/agents/...` for the global scope, which is owned by your agentsconf mirror) — then re-run `condash skills install` to recompile the per-agent outputs.

## Shipped-skill tracking

Each tree carries its own `.condash-skills.json` manifest, populated by `condash skills install`:

- `<conception>/.agents/.condash-skills.json` — source refuse-on-edit tracking (CLI internal).
- `<conception>/<skills_path>/.condash-skills.json` — Claude compiled tracking.
- `<conception>/.kimi/skills/.condash-skills.json` — Kimi compiled tracking.
- `<conception>/.opencode/skills/.condash-skills.json` — OpenCode compiled tracking.

The pane uses each manifest to flag two states on the matching tab:

- **shipped** — the on-disk content matches the version condash shipped. Cards display a `shipped` chip; the `SKILL` callout carries the same flag.
- **shipped · diverged** — the file is shipped but locally edited. Cards display an amber `shipped · diverged` chip; the `SKILL` callout switches to amber. Opening the file shows a banner: *"Shipped by condash, but locally edited. Running `condash skills install` will flag this divergence."*

The flags are informational only — local edits are never blocked. They exist so a quick scan tells you where your customisations are and warns you before an upstream re-install reverts them.

## Configuration

`skills_path` controls only the **Claude** tab's root directory. The Generic, Kimi, and OpenCode tabs always read from `.agents/skills/`, `.kimi/skills/`, and `.opencode/skills/` respectively — those paths are not user-configurable.

Set the Claude tab's directory by editing `.condash/settings.json` at the conception root (per-tree, per-host), or via **Settings → Workspace → Skills directory**. The value lives on the tree side; the global `settings.json` carries only defaults.

```json
{
  "skills_path": ".claude/skills"
}
```

The value is relative to the conception root. Absolute paths and `..` segments are rejected by the schema.
