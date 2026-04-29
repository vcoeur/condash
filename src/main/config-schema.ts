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

const terminalSettings = z
  .object({
    shell: z.string().optional(),
    shortcut: z.string().optional(),
    screenshot_dir: z.string().optional(),
    screenshot_paste_shortcut: z.string().optional(),
    launcher_command: z.string().optional(),
    move_tab_left_shortcut: z.string().optional(),
    move_tab_right_shortcut: z.string().optional(),
  })
  .strict();

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
