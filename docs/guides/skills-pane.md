# The Skills pane

The Skills pane sits alongside **Code**, **Knowledge**, and **Resources** in the right working-surface slot (`Ctrl+L` to switch in). Its header has two rows: a **Local / Global** scope toggle (with a refresh button on the right), and below it a tab bar selecting one of four trees — **Generic** (the agent-neutral source skills under `.agents/skills/`), **Claude**, **Kimi**, and **OpenCode** (each harness's skills directory, when one exists). The pane is **read-only**: it surfaces skills for browsing. Edit a skill at its source under `.agents/skills/` and re-run `condash skills install` to refresh it.

![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-light.png#only-light)
![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-dark.png#only-dark)

## Scope: Local vs Global

The first header row toggles which scope the pane reads:

- **Local** (default) — the active conception's skills.
- **Global** — the per-machine user scope under `~/.config/agents/`, `~/.claude/`, `~/.kimi/`, and `~/.config/opencode/`. condash does not write these; they're laid down by whatever user-scoped tooling owns your machine's agent config.

The selected scope is remembered per-machine in `settings.json` (`skillsActiveScope`); flipping it re-reads the active tab's tree. The **refresh** button on the right of the scope row re-reads the current tree on demand — useful in the Global scope, whose paths aren't watched for changes the way the conception tree is.

## The four tabs

Each tab reads a skills directory:

| Tab | Local reads | Global reads |
|---|---|---|
| **Generic** | `<conception>/.agents/skills/` | `~/.config/agents/skills/` |
| **Claude** | `<conception>/<skills_path>` (default `.claude/skills/`) | `~/.claude/skills/` |
| **Kimi** | `<conception>/.kimi/skills/` | `~/.kimi/skills/` |
| **OpenCode** | `<conception>/.opencode/skills/` | `~/.config/opencode/skills/` |

condash ships only the **Generic** source tree (`.agents/skills/`); the other three directories appear only if some other tool put them there. The currently-selected tab is remembered per-machine in `settings.json` (`skillsActiveTab`), so the next launch reopens the same view. The first launch after the tabs ship defaults to **Claude** to match the pre-tabs behaviour.

Each tab maintains its own directory expansion state and scroll position. Switching tabs within a scope is paint-only — all four trees are loaded eagerly when a conception is opened (and re-fetched on a scope flip or refresh).

## What each tab shows

### Generic (sources)

The Generic tab walks the `.agents/skills/` root — the agent-neutral source skills condash ships:

- Each subdirectory is a skill. Its `SKILL.md` (minimal `name` + `description` frontmatter plus the skill body) renders as a badged callout at the top of the expanded body.
- Task `.md` files (`create.md`, `close.md`, …) and any `SKILL.<harness>.md` overlay render as cards underneath. The walker recurses to any depth. Title is pulled from the first H1, falling back to the filename.

These sources are placed verbatim by `condash skills install`; condash does not compile them. A harness launcher (shipped separately) reads the source and renders each skill per agent at run time.

### Claude / Kimi / OpenCode

Same layout as the Generic tab, each rooted at the matching harness skills directory (`<skills_path>`, default `.claude/skills/`, for Claude; `.kimi/skills/` for Kimi; `.opencode/skills/` for OpenCode). condash does **not** write these directories — they appear only when another tool installs per-harness skills there. With nothing in them, the tab shows its empty state.

OpenCode discovers `.opencode/skills/` (and `~/.config/opencode/skills/`) on its own, but it *also* scans `.claude/skills/` and `.agents/skills/` and resolves a duplicate skill name by a non-deterministic race (no stable precedence). Launch OpenCode with `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` to have it read only its own dirs.

## Viewing files

Click any card to open the file in the note modal — the same viewer used elsewhere in condash, opened **read-only**. Wikilinks and relative markdown links route through the in-modal navigator just like Knowledge files. Global-scope files live outside the conception, so the pane reads them through a dedicated `readSkillFile` IPC bounded to the user-scope skill locations (never their parent dirs).

The pane never writes. To change a shipped skill, edit it at its source under `.agents/skills/` (`~/.config/agents/skills/...` for the global scope, owned by your user-scoped tooling) — then re-run `condash skills install`, which refuses to clobber the edit unless you pass `--force`.

## Shipped-skill tracking

The conception's source tree carries a single manifest populated by `condash skills install`:

- `<conception>/.agents/.condash-skills.json` — refuse-on-edit tracking for the shipped skill sources, keyed by SHA256 + shipped version.

The pane uses it to flag two states on the **Generic** tab:

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
