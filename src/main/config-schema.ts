import { z } from 'zod';

/**
 * Schemas for the two condash settings files. The unified shape lives here
 * so the global per-machine `settings.json` and the per-conception
 * `condash.json` (which replaces the legacy `configuration.json`) stay in
 * lock-step. Top-level keys in `condash.json` replace the matching keys in
 * `settings.json` at read time; the only fields a conception cannot set
 * are `lastConceptionPath` and `recentConceptionPaths`.
 */
/**
 * Submodule entries: same shape as a top-level repo, minus the recursive
 * `submodules` (no nested submodules) AND minus the section-marker variant
 * (sections are top-level only — see `topLevelRepoEntry` below).
 */
const submoduleRepoEntry: z.ZodType<RawSubmoduleRepo> = z.union([
  z.string(),
  z
    .object({
      name: z.string(),
      path: z.string().optional(),
      label: z.string().min(1).optional(),
      run: z.string().optional(),
      force_stop: z.string().optional(),
      install: z.string().optional(),
      pinned_branch: z.string().optional(),
      env: z.array(z.string().min(1)).optional(),
    })
    .strict(),
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
      name: z.string(),
      path: z.string().optional(),
      label: z.string().min(1).optional(),
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
    .strict(),
  z
    .object({
      /** Non-empty heading text. Renders as a section header in the Settings
       *  modal and groups Code-pane cards under the same label. */
      section: z.string().min(1),
    })
    .strict(),
]);

export type RawSubmoduleRepo =
  | string
  | {
      name: string;
      path?: string;
      label?: string;
      run?: string;
      force_stop?: string;
      install?: string;
      pinned_branch?: string;
      env?: string[];
    };

export type RawRepo =
  | string
  | {
      name: string;
      path?: string;
      label?: string;
      run?: string;
      force_stop?: string;
      install?: string;
      pinned_branch?: string;
      env?: string[];
      submodules?: RawSubmoduleRepo[];
    }
  | { section: string };

/** True when `entry` is the section-marker variant of `RawRepo`. */
export function isSectionMarker(entry: RawRepo): entry is { section: string } {
  return typeof entry === 'object' && entry !== null && 'section' in entry;
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
 *  skips entries whose `id` or `command` is blank. */
const agentSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    command: z.string(),
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

const layoutSchema = z
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

const cardMinWidthSchema = z
  .object({
    projects: z.number().int().positive().optional(),
    code: z.number().int().positive().optional(),
    knowledge: z.number().int().positive().optional(),
    resources: z.number().int().positive().optional(),
    skills: z.number().int().positive().optional(),
  })
  .strict();

const treeExpansionSchema = z
  .object({
    knowledge: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Constraint shared by `resources_path` and `skills_path`: the value must
 * be a non-empty, normalised relative path interpreted from the conception
 * root. Absolute paths and `..` segments are rejected — both would let the
 * panes browse outside the conception tree, which is not the user-facing
 * promise.
 */
const conceptionRelativePath = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => !value.startsWith('/'), {
    message: 'must be relative to the conception root (no leading "/")',
  })
  .refine((value) => !value.split(/[\\/]/).includes('..'), {
    message: 'must not contain ".." segments',
  });

/**
 * Workspace + presentational fields shared by global and per-conception
 * settings files. Picked apart from the path-tracking fields so the same
 * shape can be used in both files — the conception override variant just
 * omits `lastConceptionPath` + `recentConceptionPaths`.
 */
const sharedSchemaFields = {
  $schema_doc: z.string().optional(),
  workspace_path: z.string().optional(),
  worktrees_path: z.string().optional(),
  /** Directory browsed by the Resources pane (default `resources`). */
  resources_path: conceptionRelativePath.optional(),
  /** Directory browsed by the Skills pane (default `.claude/skills`). */
  skills_path: conceptionRelativePath.optional(),
  repositories: z.array(topLevelRepoEntry).optional(),
  /** Terminal-launcher agents — a flat `{id,label,command}` list surfaced in
   *  the tab-strip spawn dropdown. Replaces the per-file `<conception>/agents/`
   *  store. */
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
  /** Terminal preferences. Per-machine in settings.json; overridable per-conception. */
  terminal: terminalSettings.optional(),
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
 * conception's `condash.json` is forbidden from setting these — a tree
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
    ...sharedSchemaFields,
    ...pathTrackingFields,
  })
  .strict();

/** Schema for `<conception>/condash.json` — same shape minus path-self. */
export const conceptionConfigSchema = z.object(sharedSchemaFields).strict();

/**
 * Backwards-compatibility export. Older code referenced `configSchema`;
 * the new name is `conceptionConfigSchema`.
 */
export const configSchema = conceptionConfigSchema;

export type ConceptionConfig = z.infer<typeof conceptionConfigSchema>;

/** Backwards-compat alias. */
export type Config = ConceptionConfig;

/**
 * Default for `resources_path` when the key is absent. Kept here so the
 * schema and the resolver agree on one constant.
 */
export const DEFAULT_RESOURCES_PATH = 'resources';

/**
 * Default for `skills_path` when the key is absent. The conception template
 * already ships skills under `.claude/skills/`, so a freshly-initialised
 * tree resolves to a non-empty Skills pane out of the box.
 */
export const DEFAULT_SKILLS_PATH = '.claude/skills';

/**
 * In-place migration of legacy settings shapes ahead of strict-mode zod
 * parsing. Runs on every parse so old `settings.json` / `condash.json`
 * bodies stay readable; the schema's `.strict()` would otherwise reject
 * the stale keys outright.
 *
 * Current rules:
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

/** Backwards-compat alias for the renamed canonicaliser. */
export const validateAndCanonicaliseConfig = validateAndCanonicaliseConceptionConfig;

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
