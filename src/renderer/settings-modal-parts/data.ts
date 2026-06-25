import type {
  ActionTemplate,
  Agent,
  CardMinWidthPrefs,
  DashboardSettings,
  Platform,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
} from '@shared/types';
import { isSectionMarker, type RawRepo, type RawSubmoduleRepo } from '@shared/config-types';

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
  | 'agents:global'
  | 'dashboard:global'
  | 'workspace:conception'
  | 'repositories:conception'
  | 'open-with:conception'
  | 'appearance:conception'
  | 'terminal:conception'
  | 'agents:conception';

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
  { id: 'agents:global', label: 'Agents', tab: 'global' },
  { id: 'dashboard:global', label: 'Dashboard', tab: 'global' },
  // Conception tab.
  { id: 'workspace:conception', label: 'Workspace', tab: 'conception' },
  { id: 'repositories:conception', label: 'Repositories', tab: 'conception' },
  { id: 'open-with:conception', label: 'Open with', tab: 'conception' },
  { id: 'appearance:conception', label: 'Appearance', tab: 'conception' },
  { id: 'terminal:conception', label: 'Terminal', tab: 'conception' },
  { id: 'agents:conception', label: 'Agents', tab: 'conception' },
];

/**
 * Top-level RawConfig keys that each section reads/writes. Used by the
 * rail's dirty-pip computation: a section is dirty when any of its keys
 * differ between disk and the active draft. `recents:global` is intentionally
 * empty — recents are managed outside the settings modal.
 */
export const SECTION_KEYS: Record<Section, readonly (keyof RawConfig)[]> = {
  'recents:global': [],
  'appearance:global': ['theme', 'cardMinWidth'],
  'terminal:global': ['terminal'],
  'agents:global': ['agents'],
  'dashboard:global': ['dashboard'],
  'workspace:conception': ['workspace_path', 'worktrees_path'],
  'repositories:conception': ['repositories'],
  'open-with:conception': ['open_with'],
  'appearance:conception': ['theme', 'cardMinWidth'],
  'terminal:conception': ['terminal'],
  'agents:conception': ['agents'],
};

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

export type TerminalStringFieldKind = 'plain' | 'path' | 'shortcut';

export interface TerminalStringField {
  key: TerminalStringFieldKey;
  label: string;
  /** Per-OS placeholder. `default` is used when the platform is unknown. */
  placeholder: Partial<Record<Platform | 'default', string>>;
  hint?: string;
  /** Drives field-specific rendering: 'path' adds an [abs] chip, 'shortcut'
   *  swaps in a click-to-capture button. Defaults to 'plain'. */
  kind?: TerminalStringFieldKind;
}

export const TERMINAL_STRING_FIELDS: TerminalStringField[] = [
  {
    key: 'shell',
    label: 'Shell',
    placeholder: { linux: '/bin/bash', darwin: '/bin/zsh', win32: 'cmd.exe', default: '/bin/bash' },
    kind: 'path',
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
    kind: 'path',
  },
  {
    key: 'shortcut',
    label: 'Toggle terminal pane',
    placeholder: { default: 'Ctrl+`' },
    kind: 'shortcut',
  },
  {
    key: 'screenshot_paste_shortcut',
    label: 'Paste latest screenshot path',
    placeholder: { default: 'Ctrl+Shift+V' },
    kind: 'shortcut',
  },
  {
    key: 'move_tab_left_shortcut',
    label: 'Move tab left',
    placeholder: { default: 'Ctrl+Left' },
    kind: 'shortcut',
  },
  {
    key: 'move_tab_right_shortcut',
    label: 'Move tab right',
    placeholder: { default: 'Ctrl+Right' },
    kind: 'shortcut',
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
  repositories?: RawRepo[];
  agents?: Agent[];
  open_with?: Record<string, { label?: string; command?: string }>;
  pdf_viewer?: string[];
  theme?: Theme;
  cardMinWidth?: CardMinWidthPrefs;
  terminal?: TerminalPrefs;
  /** Live terminal-tab summarization. Global-only in the UI (the `apiKey`
   *  secret must not be committed to a conception's condash.json). */
  dashboard?: DashboardSettings;
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
      path?: string;
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
    // Drop path when it is redundant (identical to name).
    if (copy.path === copy.name) delete copy.path;
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
 * except the `repositories` array and the `terminal.{projectActions,
 * newProjectActions}` arrays — those have dedicated compactors that preserve
 * blank-row placeholders (`{ name: '' }` / `{ label: '', template: '' }`).
 * Routing them through `pruneEmpty` would
 * strip the required string fields, leaving `{}` rows that the schema
 * rejects with `expected string, received undefined`.
 */
export function buildSavePayload(config: RawConfig): RawConfig {
  const { repositories, agents, terminal, ...rest } = config;
  const pruned = pruneEmpty(rest) as RawConfig;
  if (terminal !== undefined) {
    const compacted = compactTerminal(terminal as RawTerminal);
    if (compacted !== undefined) pruned.terminal = compacted;
  }
  if (repositories !== undefined) {
    pruned.repositories = compactRepos(repositories);
  }
  if (agents !== undefined) {
    pruned.agents = compactAgents(agents);
  }
  return pruned;
}

/**
 * Normalise agent rows for disk: keep `id` / `label` / `command` verbatim
 * (all schema-valid as empty strings) so a freshly-added blank row survives
 * the save round-trip and stays visible for the user to fill in. Routing them
 * through `pruneEmpty` would strip the empty-string fields and leave `{}` rows
 * the schema can't round-trip cleanly.
 *
 * The boolean flags (`favorite`, `promptFlags`) are carried through only when
 * explicitly `true`, mirroring how the checkboxes write them (`true | undefined`).
 * Omitting this is what dropped a user's Favourite / Seed-prompt toggles on every
 * Save — they round-trip now.
 */
export function compactAgents(agents: Agent[]): Agent[] {
  return agents.map((a) => {
    const compacted: Agent = {
      id: a.id ?? '',
      label: a.label ?? '',
      command: a.command ?? '',
    };
    if (a.favorite === true) compacted.favorite = true;
    if (a.promptFlags === true) compacted.promptFlags = true;
    return compacted;
  });
}

type RawTerminal = {
  projectActions?: ActionTemplate[];
  newProjectActions?: ActionTemplate[];
  [k: string]: unknown;
};

/**
 * Pull the dynamic-row arrays out of `terminal` before pruning so blank-row
 * placeholders survive (`pruneEmpty` would strip their empty-string required
 * fields, leaving `{}` rows the schema rejects). Each surviving array is
 * normalised through its compactor: `{ submit: undefined }` and `{ title: '' }`
 * get dropped, while `{ label: '', command/template: '' }` rows are kept so
 * the user can fill them in after a reload.
 */
function compactTerminal(terminal: RawTerminal): RawTerminal | undefined {
  const { projectActions, newProjectActions, ...rest } = terminal;
  const cleaned = (pruneEmpty(rest) as RawTerminal) ?? {};
  if (projectActions !== undefined && projectActions.length > 0) {
    cleaned.projectActions = compactActionTemplates(projectActions);
  }
  if (newProjectActions !== undefined && newProjectActions.length > 0) {
    cleaned.newProjectActions = compactActionTemplates(newProjectActions);
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Normalise `actionTemplateSchema`-shaped rows for disk: keep `label` +
 * `template` verbatim, attach `submit: true` only when explicitly set, and
 * attach `agent` only when set to a non-empty string.
 */
function compactActionTemplates(arr: ActionTemplate[]): ActionTemplate[] {
  return arr.map((a) => {
    const out: ActionTemplate = {
      label: a.label ?? '',
      template: a.template ?? '',
    };
    if (a.submit === true) out.submit = true;
    if (typeof a.agent === 'string' && a.agent.length > 0) out.agent = a.agent;
    return out;
  });
}

/**
 * Filter project-card / new-project action rows down to the ones that can
 * actually be rendered as menu items: both `label` and `template` non-empty.
 * Blank-row placeholders ("+ Add action" with nothing typed yet) and
 * half-typed rows live on disk so the Settings modal can present them, but
 * the runtime dropdowns skip them.
 */
export function usableActionTemplates(arr: ActionTemplate[]): ActionTemplate[] {
  return arr.filter((a) => a.label.trim().length > 0 && a.template.trim().length > 0);
}

/** Shared drag-and-drop callback bundle. The owning parent (e.g.
 *  `RepositoriesSection`) holds the dragging-state signals; rows just emit
 *  events and read flags. */
export interface DndHandlers {
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
  isDragging: (index: number) => boolean;
  isDropTarget: (index: number) => boolean;
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

/**
 * Pure-function helpers for the Settings modal's dynamic action-template lists.
 * Both `projectActions` and `newProjectActions` share the `ActionTemplate`
 * shape. Each returns `undefined` when the resulting array is empty so the
 * caller can omit the key entirely from the saved config.
 */

export function patchActionTemplate(
  prev: ActionTemplate[] | undefined,
  index: number,
  patch: Partial<ActionTemplate>,
): ActionTemplate[] | undefined {
  const existing = (prev ?? []).map((a) => ({ ...a }));
  if (index < 0) return prev;
  if (index >= existing.length) {
    existing.push({ label: '', template: '', ...patch });
  } else {
    existing[index] = { ...existing[index], ...patch };
  }
  // Drop the row only when both label and template are blank — keep partially
  // typed rows so the user can fill the second field after the first. The
  // project-card dropdown ignores rows where either field is empty, so a
  // half-filled row is harmless at runtime.
  const kept = existing.filter((a) => a.label.trim().length > 0 || a.template.trim().length > 0);
  return kept.length > 0 ? kept : undefined;
}

export function addActionTemplate(prev: ActionTemplate[] | undefined): ActionTemplate[] {
  return [...(prev ?? []), { label: '', template: '' }];
}

export function removeActionTemplate(
  prev: ActionTemplate[] | undefined,
  index: number,
): ActionTemplate[] | undefined {
  const existing = prev ?? [];
  if (index < 0 || index >= existing.length) return prev;
  const next = existing.filter((_, i) => i !== index);
  return next.length > 0 ? next : undefined;
}

export function moveActionTemplate(
  prev: ActionTemplate[] | undefined,
  index: number,
  delta: -1 | 1,
): ActionTemplate[] | undefined {
  const arr = prev ?? [];
  const target = index + delta;
  if (target < 0 || target >= arr.length) return prev;
  const next = arr.slice();
  const [removed] = next.splice(index, 1);
  next.splice(target, 0, removed);
  return next.length > 0 ? next : undefined;
}
