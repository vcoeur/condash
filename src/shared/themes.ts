// The theme registry — the single source of truth for which colour themes
// exist, what each is called, and whether it paints a dark or a light surface
// family. Every other theme surface derives from here rather than re-typing the
// list: the `Theme` union (`shared/types/common.ts`), the zod enum and IPC
// validator (`main/config-schema.ts`, `main/ipc/settings.ts`), the Settings
// picker (`settings-modal-parts/fields/theme.tsx`), and the renderer's
// dark/light resolution (`hooks/use-theme.ts`).
//
// Adding a theme is: one entry here, one `[data-theme='<id>']` token block in
// `renderer/styles.css`, done. Nothing keys on the id anywhere else — the
// binary dark/light subsystems read `kind` through the `data-theme-kind`
// attribute, never the id.

/** Whether a preset paints a dark or a light surface family. Drives every
 *  binary subsystem (xterm, CodeMirror, highlight.js, mermaid) plus the
 *  `data-theme-kind` attribute the CSS keys its dark-only rules on. */
export type ThemeKind = 'dark' | 'light';

export interface ThemePreset {
  /** Registry id — both the persisted `theme` value and the `data-theme`
   *  attribute its token block is scoped to. Never renamed: it is on disk in
   *  every user's settings.json. */
  id: string;
  /** Display name in the Settings picker. Free to change — purely cosmetic. */
  label: string;
  kind: ThemeKind;
  /** One-line character sketch, shown under the label in the picker. */
  description: string;
  /** `[background, panel, accent]` — the three hues the picker's swatch paints.
   *  Hex literals rather than `var(--…)` reads on purpose: a swatch has to show
   *  its own theme's colours while a *different* theme is the active one, so it
   *  cannot resolve them off the live token set. Keep in sync by eye with the
   *  matching block in `styles.css`; a drift here is cosmetic (a wrong swatch),
   *  never functional. */
  swatch: readonly [string, string, string];
}

/** Every selectable theme, in picker order. */
export const THEME_PRESETS = [
  {
    id: 'light',
    label: 'Paper',
    kind: 'light',
    description: 'Warm paper light — the vcoeur editorial palette.',
    swatch: ['#faf6f8', '#ffffff', '#672167'],
  },
  {
    id: 'dark',
    label: 'Warm Gallery',
    kind: 'dark',
    description: 'Gold on warm black — the gallery-dark lead theme.',
    swatch: ['#151412', '#1a1815', '#c8a882'],
  },
  {
    id: 'console',
    label: 'Console',
    kind: 'dark',
    description: 'Terminal-native: deep ink, phosphor green, monospace throughout.',
    swatch: ['#090b0f', '#0d1117', '#4ade80'],
  },
] as const satisfies readonly ThemePreset[];

/** The id of a concrete preset — i.e. every `Theme` except `system`. */
export type ThemePresetId = (typeof THEME_PRESETS)[number]['id'];

/** The persisted theme choice: a preset id, or `system` to follow the OS
 *  between the two `SYSTEM_PAIR` presets. */
export type Theme = ThemePresetId | 'system';

/** Which presets `system` resolves to. The OS preference is a binary, so it can
 *  only ever choose between one light and one dark theme — these two. A user
 *  who wants Console picks it explicitly; there is no "follow the OS but use
 *  Console for dark" mode, and adding one would mean a second settings key. */
export const SYSTEM_PAIR: { readonly light: ThemePresetId; readonly dark: ThemePresetId } = {
  light: 'light',
  dark: 'dark',
};

/** Every accepted `theme` value, for enum validation on both sides of the IPC
 *  boundary. `system` first to match the picker's order. */
export const THEME_VALUES: readonly Theme[] = [
  'system',
  ...THEME_PRESETS.map((preset) => preset.id),
];

/** The preset with this id, or `undefined` for `system` and any unknown value.
 *  The single by-id lookup — callers that need a guaranteed preset (rather than
 *  "is this a concrete preset?") want {@link resolveThemePreset}. */
export function themePreset(theme: Theme): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === theme);
}

/** Display name for a stored choice, including the `system` pseudo-theme. */
export function themeLabel(theme: Theme): string {
  if (theme === 'system') return 'System';
  return themePreset(theme)?.label ?? theme;
}

/** The next choice in `THEME_VALUES` order — what the status-bar button cycles
 *  to. An unrecognised current value restarts the cycle at `system`. */
export function nextTheme(theme: Theme): Theme {
  const index = THEME_VALUES.indexOf(theme);
  return THEME_VALUES[(index + 1) % THEME_VALUES.length] ?? 'system';
}

/** Resolve a stored choice to the concrete preset that should paint. `system`
 *  follows `systemPrefersDark`; an unknown id (a settings file from a newer
 *  build, or a hand-edit) falls back to the same OS-following behaviour rather
 *  than throwing — a bad theme name must never leave the app unstyled. */
export function resolveThemePreset(theme: Theme, systemPrefersDark: boolean): ThemePreset {
  const match = themePreset(theme);
  if (match) return match;
  const fallbackId = systemPrefersDark ? SYSTEM_PAIR.dark : SYSTEM_PAIR.light;
  // Non-null: SYSTEM_PAIR only ever names ids that exist in THEME_PRESETS.
  return THEME_PRESETS.find((preset) => preset.id === fallbackId)!;
}
