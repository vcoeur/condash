import { z } from 'zod';
import type {
  ActionTemplate,
  Agent,
  CardMinWidthPrefs,
  AppScopeMemoryPrefs,
  AutoSyncSettings,
  DashboardSettings,
  LayoutState,
  TaskConfigEntry,
  TerminalLoggingPrefs,
  TerminalMemoryPrefs,
  TerminalPrefs,
  TerminalXtermColors,
  TerminalXtermPrefs,
  TreeExpansionPrefs,
  UiFontPrefs,
} from '../shared/types';
import { UI_FONTS } from '../shared/types';
import { isSectionMarker, type RawRepo, type RawSubmoduleRepo } from '../shared/config-types';
import { migrateRawSettings } from './config-migrate';
import {
  SCOPE_OF,
  type SettingsScope,
  type ConceptionOnlyKey,
  type GlobalOnlyKey,
  type PathTrackingKey,
} from './config-scope';

// `SCOPE_OF` / `SettingsScope` now live in the zod-free `config-scope.ts` so the
// boot-path scope-partition migrator can import them without constructing the
// schemas below. Re-exported here so existing importers (`config.ts`, the schema
// test) keep resolving against `config-schema.ts`. The `satisfies` clauses on the
// three field groups below prove the schema keys and the scope-map arrays never
// drift apart.
export { SCOPE_OF, type SettingsScope };

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
 * Schemas for the two condash settings files. The two files hold DISJOINT key
 * sets — every top-level key has exactly one home, decided by `SCOPE_OF` in
 * `config-scope.ts` (built from the `conceptionOnlyFields` / `globalOnlyFields`
 * / `pathTrackingFields` groups below), and each `.strict()` schema rejects a
 * key found in the wrong file. There is NO override, inheritance, or merge:
 * `getEffectiveConceptionConfig` (`effective-config.ts`) is a plain spread of
 * the two files, so a key only ever has one value, read from its owning file.
 * The path-tracking keys (`lastConceptionPath` / `recentConceptionPaths`) are
 * global-only — a conception cannot describe its own location. The only field
 * accepted in both files is the `$schema_doc` doc pointer (not a setting).
 * Per-key reference: `docs/reference/config.md`.
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
  } satisfies Record<keyof TerminalXtermColors, z.ZodTypeAny>)
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
  } satisfies Record<keyof TerminalXtermPrefs, z.ZodTypeAny>)
  .strict();

const terminalLoggingSettings = z
  .object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().min(0).optional(),
    maxDirMb: z.number().int().min(0).optional(),
    scrollback: z.number().int().min(100).optional(),
    markerIntervalSec: z.number().int().min(0).optional(),
  } satisfies Record<keyof TerminalLoggingPrefs, z.ZodTypeAny>)
  .strict();

/** Per-tab memory-scope limits. Sizes are opaque systemd size strings
 *  ("6G", "512M", "infinity") — systemd validates them at spawn time, so the
 *  schema only enforces "string". */
/** Backstop cap on condash's own app scope. Same opaque-size-string rules as
 *  the per-tab limits. */
const appScopeMemorySettings = z
  .object({
    enabled: z.boolean().optional(),
    max: z.string().optional(),
    swapMax: z.string().optional(),
  } satisfies Record<keyof AppScopeMemoryPrefs, z.ZodTypeAny>)
  .strict();

const terminalMemorySettings = z
  .object({
    enabled: z.boolean().optional(),
    high: z.string().optional(),
    max: z.string().optional(),
    swapMax: z.string().optional(),
    appScope: appScopeMemorySettings.optional(),
  } satisfies Record<keyof TerminalMemoryPrefs, z.ZodTypeAny>)
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
  } satisfies Record<keyof ActionTemplate, z.ZodTypeAny>)
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
  } satisfies Record<keyof Agent, z.ZodTypeAny>)
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
    memory: terminalMemorySettings.optional(),
    autoRefreshOnTabSwitch: z.boolean().optional(),
  } satisfies Record<keyof TerminalPrefs, z.ZodTypeAny>)
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
  } satisfies Record<keyof LayoutState, z.ZodTypeAny>)
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

// Same exhaustiveness guard as cardMinWidthSchema above: adding a category to
// UiFontPrefs without listing it here is a tsc error, not a silent
// `Unrecognized key` at save time. Each category is one of the four UI_FONTS.
const uiFontsSchema = z
  .object({
    cardTitle: z.enum(UI_FONTS).optional(),
    heading: z.enum(UI_FONTS).optional(),
    body: z.enum(UI_FONTS).optional(),
    code: z.enum(UI_FONTS).optional(),
    terminal: z.enum(UI_FONTS).optional(),
  } satisfies Record<keyof UiFontPrefs, z.ZodTypeAny>)
  .strict();

/**
 * Live terminal-tab summarization ("Dashboard"). Opt-in: a periodic main-process
 * loop summarizes the active terminal tabs by POSTing directly to an
 * OpenAI-compatible LLM endpoint (DeepSeek by default) — no SDK — and surfaces
 * the result as tab titles, a hover popover, and the Dashboard body in the
 * bottom band.
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
    /** Per-tab "card" model (cheap tier; default `deepseek-v4-flash`). Without a
     *  `baseUrl` it must be a built-in provider model; with a `baseUrl` it can be
     *  any id the endpoint serves. Legacy single-tier configs that set only
     *  `model` get it as the card model. */
    model: z.string().optional(),
    /** Per-card "writer" model (richer tier; default `deepseek-v4-pro`) —
     *  composes each tab's published title + subtitle from the card facts.
     *  There is no cross-tab synthesis (removed in v4.55.0). */
    writerModel: z.string().optional(),
    /** Whether the card model reasons (default false — mechanical extraction). */
    cardReasoning: z.boolean().optional(),
    /** Whether the writer model reasons (default false — a bake-off found
     *  reasoning-on returns an empty reply on a non-trivial fraction of writer
     *  calls, unacceptable now this tier owns the title). */
    writerReasoning: z.boolean().optional(),
    /** Chars of recent tab output fed to the card model (default 16000). */
    cardInputChars: z.number().int().positive().optional(),
    /** Summarization cadence in seconds. Clamped to 30–300 at read time. */
    intervalSec: z.number().int().positive().optional(),
    /** Skip a cycle when no open tab produced new output (reuses the growth gate). */
    gateOnActivity: z.boolean().optional(),
    /** Skip idle tabs that have produced no new output, even when gateOnActivity is false. */
    skipIdle: z.boolean().optional(),
    /** Max retained events per tab and globally. */
    historyLimit: z.number().int().positive().optional(),
  } satisfies Record<keyof DashboardSettings, z.ZodTypeAny>)
  .strict();

/**
 * `autoSync` — the GUI-driven periodic committer. Global/per-machine: it
 * describes how *this machine* drives commits while a conception is open, not
 * anything about the tree itself. All fields optional; `intervalMinutes` is
 * clamped to 1–120 and `quietPeriodSeconds` to 0–3600 at read time
 * (`src/main/sync/auto-config.ts`).
 */
const autoSyncSettings = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().int().positive().optional(),
    quietPeriodSeconds: z.number().int().min(0).optional(),
    push: z.boolean().optional(),
  } satisfies Record<keyof AutoSyncSettings, z.ZodTypeAny>)
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
  /** Branch names that `condash worktrees remove` must never delete. Supports
   *  glob wildcards `*` and `?`. Defaults to `["main", "master"]` when unset. */
  long_lived_branches: z.array(z.string().min(1)).optional(),
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
        } satisfies Record<keyof TaskConfigEntry, z.ZodTypeAny>)
        .strict(),
    )
    .optional(),
} satisfies Record<'$schema_doc' | ConceptionOnlyKey, z.ZodTypeAny>;

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
  /** GUI-driven periodic committer. Per-machine — describes how this machine
   *  drives commits, not the tree. See {@link autoSyncSettings}. */
  autoSync: autoSyncSettings.optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  /** Per-category UI font choices (Settings → Appearance). Any category left
   *  `default` keeps the theme's face for that surface. See {@link UiFontPrefs}. */
  uiFonts: uiFontsSchema.optional(),
  layout: layoutSchema.optional(),
  welcome: z.object({ dismissed: z.boolean().optional() }).strict().optional(),
  cardMinWidth: cardMinWidthSchema.optional(),
  treeExpansion: treeExpansionSchema.optional(),
  selectedBranches: z.array(z.string()).optional(),
  /** Branch-pin "All (sticky)" mode — when true, every branch is shown and
   *  newly-created branches are auto-pinned. When false, the `selectedBranches`
   *  set is honoured exactly (empty = only main visible). Issue #169. */
  branchFilterStickyAll: z.boolean().optional(),
} satisfies Record<'$schema_doc' | GlobalOnlyKey, z.ZodTypeAny>;

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
} satisfies Record<PathTrackingKey, z.ZodTypeAny>;

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

// `SCOPE_OF` (the key → owning-file map) and `SettingsScope` are defined in the
// zod-free `config-scope.ts` and re-exported at the top of this file. The
// `satisfies Record<…, z.ZodTypeAny>` clauses on the three field groups above
// keep the schema keys and the scope-map arrays in lock-step at compile time.

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
