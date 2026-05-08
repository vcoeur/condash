import { z } from 'zod';

/**
 * Schemas for the two condash settings files. The unified shape lives here
 * so the global per-machine `settings.json` and the per-conception
 * `condash.json` (which replaces the legacy `configuration.json`) stay in
 * lock-step. Top-level keys in `condash.json` replace the matching keys in
 * `settings.json` at read time; the only fields a conception cannot set
 * are `lastConceptionPath` and `recentConceptionPaths`.
 */
const repoEntry: z.ZodType<RawRepo> = z.lazy(() =>
  z.union([
    z.string(),
    z
      .object({
        name: z.string(),
        label: z.string().min(1).optional(),
        run: z.string().optional(),
        force_stop: z.string().optional(),
        /** Install command run after `condash-cli worktrees setup` creates the
         *  worktree. Applied unconditionally when set (#87) — pass
         *  `--no-install` on the CLI to skip. */
        install: z.string().optional(),
        /** Pin: keep this repo on a fixed branch; `worktrees setup` skips it. */
        pinned_branch: z.string().optional(),
        /** Files to copy from the primary checkout into a new worktree on
         *  `condash-cli worktrees setup`. Applied unconditionally when present —
         *  no flag needed. Default empty → no copy. Closes #82. */
        env: z.array(z.string().min(1)).optional(),
        submodules: z.array(repoEntry).optional(),
      })
      .strict(),
  ]),
);

export type RawRepo =
  | string
  | {
      name: string;
      label?: string;
      run?: string;
      force_stop?: string;
      install?: string;
      pinned_branch?: string;
      env?: string[];
      submodules?: RawRepo[];
    };

const openWithSlot = z
  .object({
    label: z.string(),
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

const terminalSettings = z
  .object({
    shell: z.string().optional(),
    shortcut: z.string().optional(),
    screenshot_dir: z.string().optional(),
    screenshot_paste_shortcut: z.string().optional(),
    launcher_command: z.string().optional(),
    move_tab_left_shortcut: z.string().optional(),
    move_tab_right_shortcut: z.string().optional(),
    xterm: xtermSettings.optional(),
  })
  .strict();

export type XtermSettings = z.infer<typeof xtermSettings>;
export type XtermColors = z.infer<typeof xtermColors>;

const layoutSchema = z
  .object({
    projects: z.boolean(),
    working: z.union([
      z.literal('code'),
      z.literal('knowledge'),
      z.literal('resources'),
      z.literal('skills'),
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
  repositories: z.array(repoEntry).optional(),
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

export type GlobalSettings = z.infer<typeof globalSettingsSchema>;
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
  const result = globalSettingsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    throw new Error(`settings.json: ${where} — ${issue.message}`);
  }
  return JSON.stringify(result.data, null, 2) + '\n';
}
