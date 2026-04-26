import { z } from 'zod';

/**
 * Schema for `<conception>/configuration.json`. Used to reject malformed shapes
 * on save; the runtime readers in repos.ts and launchers.ts still coerce the
 * legacy `commands: string[]` form for backward compatibility.
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
    command: z.string().optional(),
    commands: z.array(z.string()).optional(),
  })
  .strict()
  .refine((v) => v.command !== undefined || (v.commands && v.commands.length > 0), {
    message: 'either "command" or non-empty "commands" must be set',
  });

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

/**
 * Migrate a parsed `open_with` slot to the canonical `{ command }` form.
 * Reader-side helper used after a successful save.
 */
export function canonicaliseOpenWith(config: Config): Config {
  if (!config.open_with) return config;
  const next = { ...config, open_with: { ...config.open_with } };
  for (const key of ['main_ide', 'secondary_ide', 'terminal'] as const) {
    const slot = next.open_with![key];
    if (!slot) continue;
    if (slot.command) {
      next.open_with![key] = { label: slot.label, command: slot.command };
    } else if (slot.commands && slot.commands.length > 0) {
      next.open_with![key] = { label: slot.label, command: slot.commands[0] };
    }
  }
  return next;
}
