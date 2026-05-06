import { z } from 'zod';

/**
 * Schema for `<conception>/configuration.json`. Used to reject malformed
 * shapes on save. The shape is canonical — `open_with.{slot}` is a single
 * `{label, command}` per method, no list fallback.
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

export const configSchema = z
  .object({
    $schema_doc: z.string().optional(),
    workspace_path: z.string().optional(),
    worktrees_path: z.string().optional(),
    /** Directory browsed by the Resources pane (default `resources`). */
    resources_path: conceptionRelativePath.optional(),
    /** Directory browsed by the Skills pane (default `.claude/skills`). */
    skills_path: conceptionRelativePath.optional(),
    repositories: z
      .object({
        primary: z.array(repoEntry).optional(),
        secondary: z.array(repoEntry).optional(),
      })
      .strict()
      .optional(),
    open_with: z
      .object({
        main_ide: openWithSlot.optional(),
        secondary_ide: openWithSlot.optional(),
        terminal: openWithSlot.optional(),
      })
      .strict()
      .optional(),
    pdf_viewer: z.array(z.string()).optional(),
    /** @deprecated Terminal preferences live in settings.json now. Kept here
     * so existing files validate during the boot-time migration; do not
     * read or write this block from new code. */
    terminal: terminalSettings.optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

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
 * Parse → validate → re-serialise a `configuration.json` body.
 *
 * Lives next to the schema so the two stay in lock-step: any tightening
 * of `configSchema` automatically tightens what callers can write back
 * to disk via the renderer's NoteModal save path. Errors are formatted
 * with a dotted path so the user can see which field tripped the schema.
 *
 * Returns the canonical 2-space JSON the project's existing
 * `configuration.json` files use, with a trailing newline.
 */
export function validateAndCanonicaliseConfig(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    throw new Error(`configuration.json: ${where} — ${issue.message}`);
  }
  return JSON.stringify(result.data, null, 2) + '\n';
}
