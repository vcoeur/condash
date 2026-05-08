import type {
  CardMinWidthPrefs,
  Platform,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
} from '@shared/types';
import type { RawRepo } from '../../main/config-schema';

export type SettingsTab = 'global' | 'conception';

/**
 * Sections rendered on each tab. Theme + cardMinWidth + terminal appear on
 * BOTH tabs because they are inheritable: the global control writes to
 * `settings.json` and the conception control writes to `condash.json`. The
 * id is suffixed with `:global` / `:conception` so scroll-spy can tell them
 * apart.
 */
export type Section =
  | 'recents:global'
  | 'appearance:global'
  | 'terminal:global'
  | 'workspace:conception'
  | 'repositories:conception'
  | 'open-with:conception'
  | 'appearance:conception'
  | 'terminal:conception';

export interface SectionMeta {
  id: Section;
  label: string;
  tab: SettingsTab;
}

/**
 * Order matters — drives both the left-rail section list and the scroll-
 * spy that flips `section` as the user scrolls through the active tab's
 * panel. Workspace / Repositories / Open with live on the conception tab
 * only because that's where overriding them makes sense; the Global tab
 * hosts per-machine defaults (theme + cardMinWidth + terminal) that every
 * conception inherits unless overridden.
 */
export const SECTIONS: SectionMeta[] = [
  // Global tab.
  { id: 'recents:global', label: 'Recent conceptions', tab: 'global' },
  { id: 'appearance:global', label: 'Appearance', tab: 'global' },
  { id: 'terminal:global', label: 'Terminal', tab: 'global' },
  // Conception tab.
  { id: 'workspace:conception', label: 'Workspace', tab: 'conception' },
  { id: 'repositories:conception', label: 'Repositories', tab: 'conception' },
  { id: 'open-with:conception', label: 'Open with', tab: 'conception' },
  { id: 'appearance:conception', label: 'Appearance', tab: 'conception' },
  { id: 'terminal:conception', label: 'Terminal', tab: 'conception' },
];

export interface TabMeta {
  id: SettingsTab;
  label: string;
  file: string;
  hint: string;
}

export const TABS: TabMeta[] = [
  {
    id: 'global',
    label: 'Global',
    file: 'settings.json',
    hint: 'Per-machine defaults stored in the OS user-data directory. Owns the active conception path and the recents list. Inherited by every conception unless that conception overrides the key in its `condash.json`.',
  },
  {
    id: 'conception',
    label: 'This conception',
    file: 'condash.json',
    hint: 'Top-level keys here override the matching keys in settings.json. Reads fall back to legacy `configuration.json` when `condash.json` is absent; writes always target `condash.json`.',
  },
];

export interface ColorEntry {
  key: keyof NonNullable<TerminalXtermPrefs['colors']>;
  label: string;
}

export const TERMINAL_COLORS: ColorEntry[] = [
  { key: 'foreground', label: 'Foreground' },
  { key: 'background', label: 'Background' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'cursor_accent', label: 'Cursor accent' },
  { key: 'selection_background', label: 'Selection bg' },
  { key: 'black', label: 'ANSI black' },
  { key: 'red', label: 'ANSI red' },
  { key: 'green', label: 'ANSI green' },
  { key: 'yellow', label: 'ANSI yellow' },
  { key: 'blue', label: 'ANSI blue' },
  { key: 'magenta', label: 'ANSI magenta' },
  { key: 'cyan', label: 'ANSI cyan' },
  { key: 'white', label: 'ANSI white' },
  { key: 'bright_black', label: 'Bright black' },
  { key: 'bright_red', label: 'Bright red' },
  { key: 'bright_green', label: 'Bright green' },
  { key: 'bright_yellow', label: 'Bright yellow' },
  { key: 'bright_blue', label: 'Bright blue' },
  { key: 'bright_magenta', label: 'Bright magenta' },
  { key: 'bright_cyan', label: 'Bright cyan' },
  { key: 'bright_white', label: 'Bright white' },
];

export const CURSOR_STYLES: { value: 'block' | 'underline' | 'bar'; label: string }[] = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

export const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const OPEN_WITH_SLOTS: { key: 'main_ide' | 'secondary_ide' | 'terminal'; label: string }[] =
  [
    { key: 'main_ide', label: 'Main IDE' },
    { key: 'secondary_ide', label: 'Secondary IDE' },
    { key: 'terminal', label: 'Terminal' },
  ];

export type TerminalStringFieldKey =
  | 'shell'
  | 'shortcut'
  | 'screenshot_dir'
  | 'screenshot_paste_shortcut'
  | 'launcher_command'
  | 'move_tab_left_shortcut'
  | 'move_tab_right_shortcut';

export interface TerminalStringField {
  key: TerminalStringFieldKey;
  label: string;
  /** Per-OS placeholder. `default` is used when the platform is unknown. */
  placeholder: Partial<Record<Platform | 'default', string>>;
  hint?: string;
}

export const TERMINAL_STRING_FIELDS: TerminalStringField[] = [
  {
    key: 'shell',
    label: 'Shell',
    placeholder: { linux: '/bin/bash', darwin: '/bin/zsh', win32: 'cmd.exe', default: '/bin/bash' },
  },
  {
    key: 'launcher_command',
    label: 'Launcher command',
    placeholder: { default: 'claude' },
    hint: 'Run on terminal-tab open before any user input.',
  },
  {
    key: 'screenshot_dir',
    label: 'Screenshot directory',
    placeholder: {
      linux: '/home/you/Pictures/Screenshots',
      darwin: '~/Pictures/Screenshots',
      win32: 'C:\\Users\\you\\Pictures\\Screenshots',
      default: '~/Pictures/Screenshots',
    },
  },
  { key: 'shortcut', label: 'Toggle terminal pane', placeholder: { default: 'Ctrl+`' } },
  {
    key: 'screenshot_paste_shortcut',
    label: 'Paste latest screenshot path',
    placeholder: { default: 'Ctrl+Shift+V' },
  },
  { key: 'move_tab_left_shortcut', label: 'Move tab left', placeholder: { default: 'Ctrl+Left' } },
  {
    key: 'move_tab_right_shortcut',
    label: 'Move tab right',
    placeholder: { default: 'Ctrl+Right' },
  },
];

export const WORKSPACE_PLACEHOLDER: Partial<Record<Platform | 'default', string>> = {
  linux: '/home/you/src/vcoeur',
  darwin: '~/src/vcoeur',
  win32: 'C:\\Users\\you\\src\\vcoeur',
  default: '~/src/vcoeur',
};

export const WORKTREES_PLACEHOLDER: Partial<Record<Platform | 'default', string>> = {
  linux: '/home/you/src/worktrees',
  darwin: '~/src/worktrees',
  win32: 'C:\\Users\\you\\src\\worktrees',
  default: '~/src/worktrees',
};

export function pick(
  table: Partial<Record<Platform | 'default', string>>,
  platform: Platform | undefined,
): string {
  if (platform && table[platform]) return table[platform] as string;
  return table.default ?? '';
}

/**
 * Subset of the unified config schema that the Settings modal reads + writes.
 * Mirrors `globalSettingsSchema` / `conceptionConfigSchema` from
 * `src/main/config-schema.ts` — every overridable key is present here so
 * the same RawConfig shape can describe either file.
 */
export interface RawConfig {
  $schema_doc?: string;
  workspace_path?: string;
  worktrees_path?: string;
  resources_path?: string;
  skills_path?: string;
  repositories?: RawRepo[];
  open_with?: Record<string, { label?: string; command?: string }>;
  pdf_viewer?: string[];
  theme?: Theme;
  cardMinWidth?: CardMinWidthPrefs;
  terminal?: TerminalPrefs;
  /** Conception-only fields — never set on the conception side. */
  lastConceptionPath?: string | null;
  recentConceptionPaths?: string[];
  /** Modal UI state — last-active tab. Persists per-machine. */
  lastSettingsTab?: SettingsTab;
}

/**
 * Repository entries that carry only `{ name }` (no label / run / force_stop /
 * submodules) collapse back to the bare-string shape on save. The full
 * editor renders both shapes the same way, but configuration.json keeps its
 * compact form for entries that don't need extra fields.
 */
export function compactRepos(repos: RawRepo[]): RawRepo[] {
  return repos.map((entry) => {
    if (typeof entry === 'string') return entry;
    const copy: Exclude<RawRepo, string> = { ...entry };
    if (copy.submodules) {
      copy.submodules = compactRepos(copy.submodules);
      if (copy.submodules.length === 0) delete copy.submodules;
    }
    const extras = (Object.keys(copy) as (keyof typeof copy)[]).filter(
      (k) => k !== 'name' && copy[k] !== undefined && copy[k] !== '',
    );
    if (extras.length === 0) return copy.name;
    return copy;
  });
}

/** Strip undefined / empty-string / null leaves so the JSON file stays clean. */
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneEmpty).filter((v) => v !== undefined);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(v);
      if (pruned === undefined || pruned === '' || pruned === null) continue;
      if (typeof pruned === 'object' && !Array.isArray(pruned)) {
        if (Object.keys(pruned as Record<string, unknown>).length === 0) continue;
      }
      out[k] = pruned;
    }
    return out;
  }
  return value;
}

export type BindTextFn = (
  id: string,
  persisted: () => string | undefined,
  save: (value: string) => Promise<void>,
) => {
  value: string;
  onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
  onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
};

export function moveItem<T>(arr: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= arr.length) return arr;
  const next = arr.slice();
  const [removed] = next.splice(index, 1);
  next.splice(target, 0, removed);
  return next;
}
