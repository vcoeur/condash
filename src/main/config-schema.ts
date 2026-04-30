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

export const configSchema = z
  .object({
    $schema_doc: z.string().optional(),
    workspace_path: z.string().optional(),
    worktrees_path: z.string().optional(),
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
    terminal: terminalSettings.optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
