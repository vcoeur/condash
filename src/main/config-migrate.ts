/**
 * Zod-free settings migrator, split out of `config-schema.ts` so the CLI read
 * path can use it without paying the schema-construction cost.
 *
 * `migrateRawSettings` is the only thing the read path (`condash config get`,
 * `dirty list`, `projects list`, … — everything that resolves a conception via
 * `settings.ts` / `effective-config.ts`) needs from the config layer, and it
 * uses no zod (plain in-place object mutation). Keeping it here — with **no**
 * `import 'zod'` and no edge to `config-schema.ts` — lets those modules import
 * it directly and avoid constructing the ~15 top-level zod schemas in
 * `config-schema.ts` at module load. `config-schema.ts` imports it back for the
 * write/GUI canonicalisers (`validateAndCanonicalise*`) that legitimately use
 * zod, and re-exports it so unrelated importers keep resolving.
 */

/**
 * In-place migration of legacy settings shapes ahead of strict-mode zod
 * parsing. Runs on every parse so old `settings.json` / `condash.json`
 * bodies stay readable; the schema's `.strict()` would otherwise reject
 * the stale keys outright.
 *
 * Current rules:
 * - `resources_path` / `skills_path` (top-level) — dropped by the reframe in
 *   favour of the DEFAULT_RESOURCES_PATH / DEFAULT_SKILLS_PATH constants; and
 *   `skillsActiveTab` — a defunct UI-state key. Stripped so older files keep
 *   saving (otherwise every write fails with `Unrecognized key`).
 * - `projectCardTitleFont` (top-level) — the single-scalar font pref folded
 *   into the `uiFonts.cardTitle` category when the picker generalised to
 *   per-category fonts. Migrated into `uiFonts` (unless already present) then
 *   dropped, so an older global `settings.json` keeps saving.
 * - `terminal.launchers` / `terminal.launcher_command` — legacy tab-strip
 *   launcher keys. Removed silently so existing `settings.json` / `condash.json`
 *   files keep saving; the next write drops them from disk. (Their successor is
 *   the top-level `agents` list.)
 * - `terminal.{projectActions,newProjectActions}[].launcher` (named a launcher
 *   label) → `agent` (names an agent `id`). The old value is unlikely to match
 *   an agent id, so the action degrades to focused-tab behaviour until the user
 *   re-points it — strictly better than failing the strict-mode parse.
 * - `terminal.logging.maxFileMb` and `terminal.logging.ansiPolicy` —
 *   dropped in v2.23.0 when the rotation machinery and ANSI stripping
 *   were retired. Strip silently so existing `.condash/settings.json`
 *   files keep saving (otherwise every write fails with `Unrecognised
 *   key`, which also prevents the user from flipping `enabled: true`).
 */
export function migrateRawSettings(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const root = parsed as Record<string, unknown>;
  // The reframe dropped `resources_path` / `skills_path` in favour of the
  // DEFAULT_RESOURCES_PATH / DEFAULT_SKILLS_PATH constants; `skillsActiveTab` is
  // a defunct UI-state key with no remaining reader. Strip all three at the top
  // level (before the terminal early-return below) so the strict schema accepts
  // older files — otherwise every Settings save throws `Unrecognized key` and
  // the user can't persist any change. The next write drops them from disk.
  for (const defunctKey of ['resources_path', 'skills_path', 'skillsActiveTab']) {
    if (defunctKey in root) delete root[defunctKey];
  }
  // v4.86.0 → v4.87.0: the single `projectCardTitleFont` scalar became the
  // per-category `uiFonts` record. Fold a saved value into `uiFonts.cardTitle`
  // (the category that subsumes project-card titles) unless `uiFonts` already
  // exists, then drop the legacy key so the strict schema accepts the file —
  // otherwise every Settings save throws `Unrecognized key`. The next write
  // removes the stale key from disk.
  if ('projectCardTitleFont' in root) {
    const legacy = root.projectCardTitleFont;
    if (!('uiFonts' in root) && typeof legacy === 'string') {
      root.uiFonts = { cardTitle: legacy };
    }
    delete root.projectCardTitleFont;
  }
  // v3.20.0 → v3.21.0: the left-band pane was renamed Outputs → Deliverables.
  if (root.layout && typeof root.layout === 'object') {
    const layout = root.layout as Record<string, unknown>;
    if (layout.leftView === 'outputs') layout.leftView = 'deliverables';
  }
  const terminal = root.terminal;
  if (!terminal || typeof terminal !== 'object') return parsed;
  const term = terminal as Record<string, unknown>;
  // Launchers were replaced by Agents — drop the legacy keys so the strict
  // schema accepts the file and the next write removes them from disk.
  delete term.launchers;
  delete term.launcher_command;
  // Rename the legacy action binding `launcher` → `agent` on both action lists.
  for (const listKey of ['projectActions', 'newProjectActions']) {
    const list = term[listKey];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const action = entry as Record<string, unknown>;
      if ('launcher' in action) {
        if (!('agent' in action) && typeof action.launcher === 'string') {
          action.agent = action.launcher;
        }
        delete action.launcher;
      }
    }
  }
  const logging = term.logging;
  if (logging && typeof logging === 'object') {
    const log = logging as Record<string, unknown>;
    for (const droppedKey of ['maxFileMb', 'ansiPolicy']) {
      if (droppedKey in log) delete log[droppedKey];
    }
  }
  return parsed;
}

/**
 * Hard-coded directory name browsed by the Resources pane. The reframe
 * dropped the `resources_path` config in favour of this constant — a
 * conception either lays out its resources at `<root>/resources/` or
 * sees an empty pane. Lives in this zod-free module so read-path importers
 * (`conception-paths.ts`, …) can use it without constructing the schemas in
 * `config-schema.ts`.
 */
export const DEFAULT_RESOURCES_PATH = 'resources';

/**
 * Hard-coded directory name browsed by the Skills pane (conception scope).
 * The reframe dropped the `skills_path` config in favour of this constant —
 * the Skills pane reads agedum sources at `<conception>/.agents/skills/`
 * and never the per-harness compiled outputs.
 */
export const DEFAULT_SKILLS_PATH = '.agents/skills';
