import type {
  CardMinWidthPrefs,
  LauncherSymbol,
  Platform,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
} from '@shared/types';
import { isSectionMarker, type RawRepo, type RawSubmoduleRepo } from '../../main/config-schema';

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

/**
 * One settings-modal fieldset per launcher slot. Order is the visual
 * order. The renderer in `fields.tsx` walks this constant to produce one
 * `<fieldset>` per entry; the tab strip walks `prefs.launchers` (an
 * arbitrary subset of these symbols) to render the matching buttons.
 */
export interface LauncherFieldsetMeta {
  symbol: LauncherSymbol;
  glyph: string;
  label: string;
  commandPlaceholder: Partial<Record<Platform | 'default', string>>;
  titlePlaceholder: Partial<Record<Platform | 'default', string>>;
}

export const LAUNCHER_FIELDSETS: LauncherFieldsetMeta[] = [
  {
    symbol: 'lambda',
    glyph: 'λ',
    label: 'λ Launcher',
    commandPlaceholder: { default: 'claude' },
    titlePlaceholder: { default: 'Claude' },
  },
  {
    symbol: 'mu',
    glyph: 'μ',
    label: 'μ Launcher',
    commandPlaceholder: { default: 'python -m notebook' },
    titlePlaceholder: { default: 'Jupyter' },
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
 * editor renders both shapes the same way, but condash.json keeps its
 * compact form for entries that don't need extra fields.
 *
 * Also drops empty-string / undefined optional fields from the object form,
 * so a just-added row whose name is still blank stays as `{ "name": "" }` on
 * disk (visible row in the JSON, schema-valid `repoEntry`) rather than being
 * pruned away to `null` by the generic `pruneEmpty` pass.
 */
export function compactRepos(repos: RawRepo[]): RawRepo[] {
  return repos.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (isSectionMarker(entry)) return { section: entry.section };
    // Repo-object variant from here on.
    const copy = { ...entry } as {
      name: string;
      label?: string;
      run?: string;
      force_stop?: string;
      install?: string;
      pinned_branch?: string;
      env?: string[];
      submodules?: RawSubmoduleRepo[];
    };
    if (copy.submodules) {
      copy.submodules = compactRepos(copy.submodules) as RawSubmoduleRepo[];
      if (copy.submodules.length === 0) delete copy.submodules;
    }
    for (const k of Object.keys(copy) as (keyof typeof copy)[]) {
      if (k === 'name') continue;
      if (copy[k] === undefined || copy[k] === '') delete copy[k];
    }
    const extras = (Object.keys(copy) as (keyof typeof copy)[]).filter((k) => k !== 'name');
    // Only compact to a bare string when there is an actual name to compact
    // to — a blank placeholder row keeps the object shape so the user sees
    // it both in the editor and in the JSON file.
    if (extras.length === 0 && copy.name) return copy.name;
    return { ...copy, name: copy.name ?? '' };
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

/**
 * Build the JSON payload that the Settings modal hands to `writeNote` (or
 * `writeGlobalSettings`). Strips empty leaves with `pruneEmpty` for everything
 * except the `repositories` array — `compactRepos` is the canonical
 * normaliser there. Routing repos through `pruneEmpty` would erase a freshly
 * added `{ name: '' }` row's only key, leaving an empty object that
 * `compactRepos` then maps to `undefined` → `null` on serialisation, which
 * the `repoEntry` schema rejects (`repositories.<index> — Invalid input`).
 */
export function buildSavePayload(config: RawConfig): RawConfig {
  const { repositories, ...rest } = config;
  const pruned = pruneEmpty(rest) as RawConfig;
  if (repositories !== undefined) {
    pruned.repositories = compactRepos(repositories);
  }
  return pruned;
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
