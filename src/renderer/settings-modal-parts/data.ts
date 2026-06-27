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

/** Which file owns a section. `global` → personal per-machine `settings.json`;
 *  `conception` → this tree's `.condash/settings.json`. Every section has
 *  exactly one scope now — there is no inheritance or override. Alias of
 *  `SettingsTab`, named for the scope-chip vocabulary the new UI uses. */
export type SettingsScope = SettingsTab;

/** Each setting lives in exactly one file, so each section appears exactly
 *  once (no `:global`/`:conception` duplication). */
export type Section =
  | 'recents'
  | 'appearance'
  | 'terminal'
  | 'agents'
  | 'open-with'
  | 'dashboard'
  | 'workspace'
  | 'repositories';

export interface SectionMeta {
  id: Section;
  label: string;
  scope: SettingsScope;
}

/**
 * Order matters — drives the grouped left-rail and the scroll-spy that flips
 * the active section. Sections are grouped by `scope`: the personal group
 * (settings.json) first, then this-conception (.condash/settings.json). Each
 * section is rendered once, with a scope chip naming its file.
 */
export const SECTIONS: SectionMeta[] = [
  // Personal · this machine — settings.json.
  { id: 'recents', label: 'Recent conceptions', scope: 'global' },
  { id: 'appearance', label: 'Appearance', scope: 'global' },
  { id: 'terminal', label: 'Terminal', scope: 'global' },
  { id: 'agents', label: 'Launchers', scope: 'global' },
  { id: 'open-with', label: 'Open with', scope: 'global' },
  { id: 'dashboard', label: 'Dashboard', scope: 'global' },
  // This conception — .condash/settings.json.
  { id: 'workspace', label: 'Workspace & paths', scope: 'conception' },
  { id: 'repositories', label: 'Repositories', scope: 'conception' },
];

/**
 * Top-level RawConfig keys each section reads/writes — drives the rail's
 * unsaved-changes pip (a section is dirty when any of its keys differ between
 * disk and the active draft). `recents` is empty: it is managed outside the
 * modal.
 */
export const SECTION_KEYS: Record<Section, readonly (keyof RawConfig)[]> = {
  recents: [],
  appearance: ['theme', 'cardMinWidth'],
  terminal: ['terminal'],
  agents: ['agents'],
  'open-with': ['open_with'],
  dashboard: ['dashboard'],
  workspace: ['workspace_path', 'worktrees_path'],
  repositories: ['repositories'],
};

/** The on-disk file each scope writes to (shown in the scope-chip tooltip). */
export const SCOPE_FILE: Record<SettingsScope, string> = {
  global: 'settings.json',
  conception: '.condash/settings.json',
};

/** Short chip label for a scope. */
export const SCOPE_LABEL: Record<SettingsScope, string> = {
  global: 'Personal',
  conception: 'This conception',
};

/** Rail group header for a scope. */
export const SCOPE_GROUP_LABEL: Record<SettingsScope, string> = {
  global: 'Personal · this machine',
  conception: 'This conception',
};

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
  /** Live terminal-tab summarization. Personal/global key (the `apiKey`
   *  secret never lands in a tree's settings file). */
  dashboard?: DashboardSettings;
  /** Path-tracking fields — global file only, never written by a section. */
  lastConceptionPath?: string | null;
  recentConceptionPaths?: string[];
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
