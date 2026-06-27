import { z } from 'zod';
import type { CardMinWidthPrefs, TreeExpansionPrefs } from '../shared/types';
import { isSectionMarker, type RawRepo, type RawSubmoduleRepo } from '../shared/config-types';
import { migrateRawSettings } from './config-migrate';

// The raw repo-entry contract is process-agnostic and lives in shared/ so the
// renderer can reference it without importing this zod-based module. Re-export
// it here so existing main-process and CLI imports keep resolving.
export { isSectionMarker, type RawRepo, type RawSubmoduleRepo };

// `migrateRawSettings` lives in the zod-free `config-migrate.ts` so the CLI read
// path can use it without constructing the schemas below. Re-exported here so
// the write/GUI canonicalisers (which call it) and existing importers
// (`config.ts`, the schema test) keep resolving against `config-schema.ts`.
export { migrateRawSettings };

/**
 * Schemas for the two condash settings files. The unified shape lives here
 * so the global per-machine `settings.json` and the per-conception
 * `condash.json` (which replaces the legacy `configuration.json`) stay in
 * lock-step. Top-level keys in `condash.json` replace the matching keys in
 * `settings.json` at read time; the only fields a conception cannot set
 * are `lastConceptionPath` and `recentConceptionPaths`.
 *
 * Field-naming convention (FROZEN — see `config-schema.test.ts`):
 * the user-facing config surface mixes two casings for historical reasons,
 * and existing keys are NOT renamed (a rename is a breaking settings
 * migration). The rule for which casing a *new* key takes:
 *
 *   - **snake_case** for the repo-entry / terminal-shell vocabulary —
 *     anything under `repositories[]` (`pinned_branch`, `force_stop`, …) and
 *     the `terminal.xterm` shell-style block (`font_family`, `cursor_blink`,
 *     `cursor_style`, `letter_spacing`, `line_height`), plus the open-with
 *     slots (`open_with`, `main_ide`, `pdf_viewer`). These read like
 *     shell/dotfile config and stay snake.
 *   - **camelCase** for app/UI preference keys — everything else
 *     (`cardMinWidth`, `leftView`, `treeExpansion`, `retentionDays`,
 *     `runMode`, `newProjectActions`, …).
 *
 * A new key must match one of the two casings (the test guard rejects any
 * top-level key that is neither pure snake_case nor pure camelCase), and a
 * new key in an existing group must follow that group's casing. When in
 * doubt for a genuinely new group, prefer camelCase. Do not introduce a third
 * style (kebab-case, PascalCase, SCREAMING_SNAKE).
 */
/**
 * A repo entry needs a locator (`name` or `path`) once it carries any other
 * content. A wholly-blank `{ name: "" }` stays valid so a freshly-added,
 * not-yet-filled row in the Settings editor survives the round-trip to disk.
 */
function repoEntryHasLocatorWhenPopulated(entry: {
  handle?: string;
  name?: string;
  path?: string;
  label?: string;
  aliases?: string[];
  run?: string;
  force_stop?: string;
  install?: string;
  pinned_branch?: string;
  env?: string[];
  submodules?: unknown[];
}): boolean {
  if (entry.name || entry.path) return true;
  const hasOtherContent = !!(
    entry.handle ||
    entry.label ||
    entry.aliases?.length ||
    entry.run ||
    entry.force_stop ||
    entry.install ||
    entry.pinned_branch ||
    entry.env?.length ||
    entry.submodules?.length
  );
  return !hasOtherContent;
}

/**
 * Submodule entries: same shape as a top-level repo, minus the recursive
 * `submodules` (no nested submodules) AND minus the section-marker variant
 * (sections are top-level only — see `topLevelRepoEntry` below).
 */
const submoduleRepoEntry: z.ZodType<RawSubmoduleRepo> = z.union([
  z.string(),
  z
    .object({
      handle: z.string().min(1).optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      label: z.string().min(1).optional(),
      aliases: z.array(z.string().min(1)).optional(),
      run: z.string().optional(),
      force_stop: z.string().optional(),
      install: z.string().optional(),
      pinned_branch: z.string().optional(),
      env: z.array(z.string().min(1)).optional(),
    })
    .strict()
    .refine(repoEntryHasLocatorWhenPopulated, {
      message: 'a repo entry needs at least one of `name` or `path`',
    }),
]);

/**
 * Top-level entries: a name string, a full repo object (with optional
 * `submodules`), or a section marker that groups everything until the next
 * marker into a labelled bucket. Section markers carry no behaviour — they
 * only steer the Settings UI and the Code pane's card grouping. The walker
 * in `config-walk.ts` strips them out before any consumer sees the list.
 */
const topLevelRepoEntry: z.ZodType<RawRepo> = z.union([
  z.string(),
  z
    .object({
      /** Canonical `#handle` for this app — the one reference used in pills,
       *  project `apps:` lists, the generated AGENTS.md table, the colour
       *  hash, and search. When omitted it defaults to `appHandle(name)`
       *  (i.e. the directory name lowercased), so simple repos need not set
       *  it; domain-style or camelCase repos do (e.g. `kasten`). */
      handle: z.string().min(1).optional(),
      /** Directory name. Optional when `path` is given (the dir name is then
       *  `basename(path)`). Still accepted as the sole locator for the legacy
       *  bare-string and `{name}` forms. */
      name: z.string().optional(),
      path: z.string().optional(),
      label: z.string().min(1).optional(),
      /** Legacy spellings that resolve to this handle — drives the cleanup
       *  rewriter and lets `applications validate` auto-suggest a fix. */
      aliases: z.array(z.string().min(1)).optional(),
      run: z.string().optional(),
      force_stop: z.string().optional(),
      /** Install command run after `condash worktrees setup` creates the
       *  worktree. Applied unconditionally when set (#87) — pass
       *  `--no-install` on the CLI to skip. */
      install: z.string().optional(),
      /** Pin: keep this repo on a fixed branch; `worktrees setup` skips it. */
      pinned_branch: z.string().optional(),
      /** Files to copy from the primary checkout into a new worktree on
       *  `condash worktrees setup`. Applied unconditionally when present —
       *  no flag needed. Default empty → no copy. Closes #82. */
      env: z.array(z.string().min(1)).optional(),
      submodules: z.array(submoduleRepoEntry).optional(),
    })
    .strict()
    .refine(repoEntryHasLocatorWhenPopulated, {
      message: 'a repo entry needs at least one of `name` or `path`',
    }),
  z
    .object({
      /** Non-empty heading text. Renders as a section header in the Settings
       *  modal and groups Code-pane cards under the same label. */
      section: z.string().min(1),
    })
    .strict(),
]);

/**
 * A retired app: a handle that closed projects still reference but whose repo
 * no longer exists. It has no `path` and renders no code card; it exists so
 * `applications validate` accepts the historical `#handle` and the cleanup
 * rewriter can map its legacy spellings.
 */
const retiredAppEntry = z
  .object({
    handle: z.string().min(1),
    label: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** A retired (defunct) app handle — see {@link retiredAppEntry}. */
export interface RetiredApp {
  handle: string;
  label?: string;
  aliases?: string[];
}

const openWithSlot = z
  .object({
    label: z.string().optional(),
    command: z.string().min(1),
  })
  .strict();

const xtermColors = z
  .object({
    foreground: z.string().optional(),
    background: z.string().optional(),
    cursor: z.string().optional(),
    cursor_accent: z.string().optional(),
    selection_background: z.string().optional(),
    black: z.string().optional(),
    red: z.string().optional(),
    green: z.string().optional(),
    yellow: z.string().optional(),
    blue: z.string().optional(),
    magenta: z.string().optional(),
    cyan: z.string().optional(),
    white: z.string().optional(),
    bright_black: z.string().optional(),
    bright_red: z.string().optional(),
    bright_green: z.string().optional(),
    bright_yellow: z.string().optional(),
    bright_blue: z.string().optional(),
    bright_magenta: z.string().optional(),
    bright_cyan: z.string().optional(),
    bright_white: z.string().optional(),
  })
  .strict();

const xtermSettings = z
  .object({
    font_family: z.string().optional(),
    font_size: z.number().int().positive().optional(),
    line_height: z.number().positive().optional(),
    letter_spacing: z.number().optional(),
    font_weight: z.union([z.string(), z.number()]).optional(),
    font_weight_bold: z.union([z.string(), z.number()]).optional(),
    cursor_style: z.enum(['block', 'underline', 'bar']).optional(),
    cursor_blink: z.boolean().optional(),
    scrollback: z.number().int().nonnegative().optional(),
    ligatures: z.boolean().optional(),
    colors: xtermColors.optional(),
  })
  .strict();

const terminalLoggingSettings = z
  .object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().min(0).optional(),
    maxDirMb: z.number().int().min(0).optional(),
    scrollback: z.number().int().min(100).optional(),
    markerIntervalSec: z.number().int().min(0).optional(),
  })
  .strict();

/** Single launcher slot. `label` is the user-defined display name shown
 *  in the tab-strip dropdown; `command` is the shell command run on spawn;
 *  `title`, when present, is the initial pinned tab label.
 *
 *  `label` and `command` accept empty strings so a freshly-added blank row
 *  ("+ Add launcher") survives the round-trip to disk and stays visible for
 *  the user to fill in. The tab-strip dropdown skips entries whose `command`
 *  is empty — same effective behaviour as the previous `.min(1)` constraint
 *  but without the failed-save UX. */
/** One user-configurable action template for project cards or the
 *  "+ New project" button. `label` and `template` accept empty strings so a
 *  freshly-added row is schema-valid; the project-card dropdown skips entries
 *  whose `template` is empty.
 *
 *  `agent`, when set, names an agent (`<harness>-<model_variant>`) defined
 *  under `<conception>/agents/`. The action spawns a fresh tab running that
 *  agent then types the template into it — lets users bind, e.g., "Start new
 *  project" to a specific agent instead of typing into whatever shell happens
 *  to be focused. Empty / missing keeps the legacy behaviour (type into the
 *  focused tab; spawn a plain shell only if no tab exists). */
const actionTemplateSchema = z
  .object({
    label: z.string(),
    template: z.string(),
    submit: z.boolean().optional(),
    agent: z.string().optional(),
  })
  .strict();

/** One terminal-launcher agent. `id` is the stable identity referenced by
 *  tasks and action templates; `label` is the spawn-dropdown display name;
 *  `command` is the shell command run on launch. All three accept empty
 *  strings so a freshly-added blank row in the Settings editor survives the
 *  round-trip to disk and stays visible for the user to fill in; `listAgents`
 *  skips entries whose `id` or `command` is blank. Optional `promptFlags` opts
 *  the agent into argv prompt-seeding (`--prompt`) instead of the keystroke
 *  path; optional `favorite` surfaces it directly in the spawn dropdown (the
 *  rest move under `More ▸`) — see the `Agent` type. */
const agentSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    command: z.string(),
    promptFlags: z.boolean().optional(),
    favorite: z.boolean().optional(),
  })
  .strict();

const terminalSettings = z
  .object({
    shell: z.string().optional(),
    shortcut: z.string().optional(),
    screenshot_dir: z.string().optional(),
    screenshot_paste_shortcut: z.string().optional(),
    move_tab_left_shortcut: z.string().optional(),
    move_tab_right_shortcut: z.string().optional(),
    xterm: xtermSettings.optional(),
    logging: terminalLoggingSettings.optional(),
    projectActions: z.array(actionTemplateSchema).optional(),
    newProjectActions: z.array(actionTemplateSchema).optional(),
  })
  .strict();

/** LayoutState validator. Exported so the `setLayout` IPC handler can apply
 *  the same shape check the settings save path enforces. */
export const layoutSchema = z
  .object({
    projects: z.boolean(),
    // Optional: layouts persisted before `leftView` existed omit it; the read
    // path back-fills from DEFAULT_LAYOUT. The legacy `'outputs'` value (v3.20.0)
    // is migrated to `'deliverables'` in migrateRawSettings.
    leftView: z
      .union([z.literal('projects'), z.literal('tasks'), z.literal('deliverables')])
      .optional(),
    working: z.union([
      z.literal('code'),
      z.literal('knowledge'),
      z.literal('resources'),
      z.literal('skills'),
      z.literal('logs'),
      z.null(),
    ]),
    terminal: z.boolean(),
    projectsWidth: z.number().int().positive(),
  })
  .strict();

// One entry per card grid. The `satisfies Record<keyof CardMinWidthPrefs, …>`
// makes this list exhaustive at compile time: adding a pane to CardMinWidthPrefs
// without adding it here is a tsc error, not a silent `Unrecognized key` at save
// time. This is the guard that was missing when logs/tasks/deliverables shipped.
const cardMinWidthSchema = z
  .object({
    projects: z.number().int().positive().optional(),
    code: z.number().int().positive().optional(),
    knowledge: z.number().int().positive().optional(),
    resources: z.number().int().positive().optional(),
    skills: z.number().int().positive().optional(),
    logs: z.number().int().positive().optional(),
    tasks: z.number().int().positive().optional(),
    deliverables: z.number().int().positive().optional(),
  } satisfies Record<keyof CardMinWidthPrefs, z.ZodTypeAny>)
  .strict();

// Same exhaustiveness guard as cardMinWidthSchema above: adding a key to
// TreeExpansionPrefs without listing it here is a tsc error, not a silent
// `Unrecognized key` at save time (which is how `skillsUser` shipped unsavable).
const treeExpansionSchema = z
  .object({
    knowledge: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    skillsUser: z.array(z.string()).optional(),
  } satisfies Record<keyof TreeExpansionPrefs, z.ZodTypeAny>)
  .strict();

/**
 * Live terminal-tab summarization ("Dashboard"). Opt-in: a periodic main-process
 * loop summarizes the active terminal tabs with the pi coding-agent SDK and
 * surfaces the result as tab titles, a hover popover, and the Dashboard pane.
 *
 * Per-machine in `settings.json` — `apiKey` is a secret and MUST live in the
 * global file, never a versioned conception `condash.json`. All fields are
 * optional; the engine applies defaults (provider `deepseek`, model
 * `deepseek-v4-flash`, interval 120s clamped 30–300, activity-gated, 20 events).
 */
const dashboardSettings = z
  .object({
    /** Master switch. Off by default — nothing runs and no data leaves the machine. */
    enabled: z.boolean().optional(),
    /** LLM provider. DeepSeek only for now; an enum so others can be added later. */
    provider: z.enum(['deepseek']).optional(),
    /** Provider API key. GLOBAL settings only — never commit it to a conception file. */
    apiKey: z.string().optional(),
    /** OpenAI-compatible API base URL. Blank → the provider's built-in endpoint
     *  (`https://api.deepseek.com`). Set it to point at a self-hosted /
     *  OpenAI-compatible gateway (e.g. an opencode-go server) with any `model` id. */
    baseUrl: z.string().optional(),
    /** Model id (default `deepseek-v4-flash`). Without a `baseUrl` it must be a
     *  built-in provider model; with a `baseUrl` it can be any id the endpoint serves. */
    model: z.string().optional(),
    /** Summarization cadence in seconds. Clamped to 30–300 at read time. */
    intervalSec: z.number().int().positive().optional(),
    /** Skip a cycle when no open tab produced new output (reuses the growth gate). */
    gateOnActivity: z.boolean().optional(),
    /** Max retained events per tab and globally. */
    historyLimit: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Fields owned by the per-conception `.condash/settings.json` — the things
 * that describe **this one tree**: where its repos live, the repo list, the
 * defunct handles its closed projects reference, and its task config. Every
 * other setting is personal/per-machine and lives in the global file.
 *
 * `$schema_doc` is a documentation pointer (not a setting); it is allowed in
 * either file and is therefore the one key present in both field groups.
 */
const conceptionOnlyFields = {
  $schema_doc: z.string().optional(),
  workspace_path: z.string().optional(),
  worktrees_path: z.string().optional(),
  repositories: z.array(topLevelRepoEntry).optional(),
  /** Defunct app handles kept for historical project references. Validated
   *  against, never rendered as code cards. */
  retired_apps: z.array(retiredAppEntry).optional(),
  /** Per-task config keyed by task slug (capability 1). `schedule` is an
   *  opt-in cadence (`30s`/`2m`/`1h`/`7d`) that arms the headless scheduler;
   *  absent = not scheduled. `timeout` is the per-task run-timeout override
   *  (same cadence syntax; absent = the scheduler's 10m default).
   *  `excludeFromLogs` is the per-task default for routing a manual run out of
   *  `.condash/logs/` into `.condash/manual/<slug>/`, overridable per run.
   *  `runMode` is the per-task default for how a `promptFlags` agent is driven
   *  (`interactive` → agedum `--prompt`, `oneshot` → `--run`), overridable per
   *  run. No default entries — a task is inert until added. */
  taskConfig: z
    .record(
      z.string(),
      z
        .object({
          schedule: z.string().optional(),
          timeout: z.string().optional(),
          excludeFromLogs: z.boolean().optional(),
          runMode: z.enum(['interactive', 'oneshot']).optional(),
          gateOnUpdatedTabs: z.boolean().optional(),
        })
        .strict(),
    )
    .optional(),
} as const;

/**
 * Fields owned by the per-machine global `settings.json` — everything that
 * describes **you / this machine / the app**, identical no matter which
 * conception is open. Disjoint from {@link conceptionOnlyFields} (save for the
 * shared `$schema_doc` doc pointer), so the two `.strict()` schemas below can
 * never accept the same setting key in both files.
 */
const globalOnlyFields = {
  $schema_doc: z.string().optional(),
  /** Terminal-launcher agents — a flat `{id,label,command}` list surfaced in
   *  the tab-strip spawn dropdown. Personal tools, identical across trees. */
  agents: z.array(agentSchema).optional(),
  open_with: z
    .object({
      main_ide: openWithSlot.optional(),
      secondary_ide: openWithSlot.optional(),
      terminal: openWithSlot.optional(),
    })
    .strict()
    .optional(),
  pdf_viewer: z.array(z.string()).optional(),
  /** Terminal preferences (device/input, `xterm`, on-disk `logging`, and the
   *  project-workflow action templates). Per-machine — one whole global key. */
  terminal: terminalSettings.optional(),
  /** Live terminal-tab summarization. The `apiKey` secret keeps this global;
   *  it reads the same terminal-capture pipeline as `terminal.logging`. See
   *  {@link dashboardSettings}. */
  dashboard: dashboardSettings.optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  layout: layoutSchema.optional(),
  welcome: z.object({ dismissed: z.boolean().optional() }).strict().optional(),
  cardMinWidth: cardMinWidthSchema.optional(),
  treeExpansion: treeExpansionSchema.optional(),
  selectedBranches: z.array(z.string()).optional(),
  /** Branch-pin "All (sticky)" mode — when true, every branch is shown and
   *  newly-created branches are auto-pinned. When false, the `selectedBranches`
   *  set is honoured exactly (empty = only main visible). Issue #169. */
  branchFilterStickyAll: z.boolean().optional(),
} as const;

/**
 * Path-tracking fields the global per-machine `settings.json` owns. A
 * conception's settings file is forbidden from setting these — a tree
 * cannot describe its own location, and the recents list is necessarily
 * machine-local.
 */
const pathTrackingFields = {
  /** Currently-open conception path. Replaces the older `conceptionPath`. */
  lastConceptionPath: z.string().nullable().optional(),
  /** Most-recently-opened paths, newest first, capped at RECENT_CONCEPTION_PATHS_CAP. */
  recentConceptionPaths: z.array(z.string()).optional(),
} as const;

/** Schema for `<userData>/settings.json`. */
export const globalSettingsSchema = z
  .object({
    ...globalOnlyFields,
    ...pathTrackingFields,
    /** Active scope toggle in the Skills pane (`conception` vs `user`).
     *  Per-machine UI state written by `setSkillsActiveScope`. Mirrors
     *  `SkillScope` in shared/types/settings.ts. */
    skillsActiveScope: z.enum(['conception', 'user']).optional(),
  })
  .strict();

/** Schema for `<conception>/.condash/settings.json` — the disjoint tree-owned
 *  field group. A global key found here is rejected by `.strict()`. */
export const conceptionConfigSchema = z.object(conceptionOnlyFields).strict();

export type ConceptionConfig = z.infer<typeof conceptionConfigSchema>;

export type SettingsScope = 'global' | 'conception';

/**
 * Single source of truth for which file owns each top-level setting key,
 * derived from the two disjoint field groups so it can never drift from the
 * schemas. The migrator, the CLI `config set`, and the Settings UI route a
 * key to its owning file through this map rather than re-encoding the split.
 * `$schema_doc` is a doc pointer allowed in either file and is intentionally
 * absent.
 */
export const SCOPE_OF: Record<string, SettingsScope> = {
  ...Object.fromEntries(
    Object.keys(conceptionOnlyFields)
      .filter((key) => key !== '$schema_doc')
      .map((key) => [key, 'conception' as const]),
  ),
  ...Object.fromEntries(
    Object.keys(globalOnlyFields)
      .filter((key) => key !== '$schema_doc')
      .map((key) => [key, 'global' as const]),
  ),
  ...Object.fromEntries(Object.keys(pathTrackingFields).map((key) => [key, 'global' as const])),
  skillsActiveScope: 'global',
};

// `DEFAULT_RESOURCES_PATH` / `DEFAULT_SKILLS_PATH` live in the zod-free
// `config-migrate.ts` so read-path importers don't construct the schemas above.

/**
 * Parse → validate → re-serialise a conception's `condash.json` (or its
 * legacy `configuration.json`) body. Used by the renderer's NoteModal save
 * path so the bytes that hit disk are always schema-canonical.
 */
export function validateAndCanonicaliseConceptionConfig(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  parsed = migrateRawSettings(parsed);
  const result = conceptionConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    throw new Error(`condash.json: ${where} — ${issue.message}`);
  }
  return JSON.stringify(result.data, null, 2) + '\n';
}

/**
 * Parse → validate → re-serialise the per-machine `settings.json` body. Used
 * by the Settings modal's Global-tab save path so the bytes that hit disk
 * are always schema-canonical and the path-tracking fields stay welcomed.
 */
export function validateAndCanonicaliseGlobalSettings(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  parsed = migrateRawSettings(parsed);
  const result = globalSettingsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    throw new Error(`settings.json: ${where} — ${issue.message}`);
  }
  return JSON.stringify(result.data, null, 2) + '\n';
}
