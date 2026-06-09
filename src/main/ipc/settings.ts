import { ipcMain } from 'electron';
import { toPosix } from '../../shared/path';
import { layoutSchema } from '../config-schema';
import { getEffectiveConceptionConfig } from '../effective-config';
import { DEFAULT_LAYOUT, readSettings, settingsPath, updateSettings } from '../settings';
import type {
  CardMinWidthPrefs,
  LayoutState,
  SkillScope,
  Theme,
  TreeExpansionPrefs,
} from '../../shared/types';
import { CARD_MIN_WIDTH_KEYS, DEFAULT_CARD_MIN_WIDTH, SKILL_SCOPES } from '../../shared/types';
import { requireBoolean, requireEnum, requireMainWindowSender, requireStringArray } from './utils';

// Tree-expansion keys after the reframe: knowledge, resources, plus one
// skills set per scope (conception / user). The pre-reframe per-harness
// keys (`skillsGeneric`, `skillsClaude`, `skillsKimi`, `skillsOpencode`)
// collapsed into the single conception-scope `skills` key — they're
// accepted on read for back-compat but never written back.
const TREE_EXPANSION_KEYS = ['knowledge', 'resources', 'skills', 'skillsUser'] as const;
type TreeExpansionKey = (typeof TREE_EXPANSION_KEYS)[number];

const SKILL_SCOPE_SET: ReadonlySet<SkillScope> = new Set(SKILL_SCOPES);

const THEMES: ReadonlySet<Theme> = new Set(['light', 'dark', 'system']);

// Canonical card-grid key list (shared/types/settings.ts), not a local copy — so the
// read/write/prune paths below always cover every pane the type knows about.
const CARD_MIN_KEYS = CARD_MIN_WIDTH_KEYS;
type CardKey = (typeof CARD_MIN_KEYS)[number];

/**
 * Coerce the user-supplied min-width to a sensible CSS pixel count.
 * Returns `undefined` for non-finite or out-of-range input — that key then
 * inherits the built-in default. The 120 px floor stops the grid from
 * collapsing into a single-card-fits-everything row; the 2400 px ceiling
 * just bounds typos.
 */
function clampMinWidth(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < 120 || rounded > 2400) return undefined;
  return rounded;
}

/**
 * Drop keys that match the built-in default so settings.json stays small
 * and the bundled defaults can change in a future release without leaving
 * stale literals on every machine.
 */
function pruneDefaults(prefs: CardMinWidthPrefs): CardMinWidthPrefs | undefined {
  const out: CardMinWidthPrefs = {};
  for (const key of CARD_MIN_KEYS) {
    const v = prefs[key];
    if (typeof v === 'number' && v !== DEFAULT_CARD_MIN_WIDTH[key]) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Wire every theme / layout / welcome / settings-path IPC handler.
 *
 * `onLayoutChange` is invoked on every successful setLayout — main entry
 * uses it to rebuild the application menu so the View submenu's check
 * marks line up with the new state.
 */
export function registerSettingsIpc(opts: { onLayoutChange: (layout: LayoutState) => void }): void {
  ipcMain.handle('getTheme', async (event) => {
    requireMainWindowSender(event);
    // Effective theme: condash.json's override beats settings.json's
    // global value. Falls back to 'system' when neither side has set a
    // theme. Re-routed through the effective resolver in v2.15.1 so
    // per-conception overrides take effect app-wide.
    const settings = await readSettings();
    if (settings.lastConceptionPath) {
      const effective = await getEffectiveConceptionConfig(settings.lastConceptionPath);
      if (effective.theme) return effective.theme as Theme;
    }
    return settings.theme;
  });

  ipcMain.handle('getSettingsPath', (event) => {
    requireMainWindowSender(event);
    return toPosix(settingsPath());
  });

  ipcMain.handle('setTheme', async (event, theme: Theme) => {
    requireMainWindowSender(event);
    const value = requireEnum('setTheme', theme, THEMES);
    await updateSettings((cur) => ({ ...cur, theme: value }));
  });

  ipcMain.handle('getLayout', async (event) => {
    requireMainWindowSender(event);
    const { layout } = await readSettings();
    return layout ?? DEFAULT_LAYOUT;
  });

  ipcMain.handle('setLayout', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    // Same shape check the settings save path enforces — keeps the IPC trust
    // boundary uniform with the shared decoders used by the other setters.
    const result = layoutSchema.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      throw new Error(`setLayout: expected a LayoutState (${where} — ${issue.message})`);
    }
    const layout = result.data as LayoutState;
    await updateSettings((cur) => ({ ...cur, layout }));
    opts.onLayoutChange(layout);
  });

  ipcMain.handle('getWelcomeDismissed', async (event) => {
    requireMainWindowSender(event);
    const { welcome } = await readSettings();
    return welcome?.dismissed === true;
  });

  ipcMain.handle('setWelcomeDismissed', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const value = requireBoolean('setWelcomeDismissed', raw);
    await updateSettings((cur) => ({
      ...cur,
      welcome: { ...(cur.welcome ?? {}), dismissed: value },
    }));
  });

  ipcMain.handle('getCardMinWidth', async (event) => {
    requireMainWindowSender(event);
    // Effective per-pane min-width: condash.json's override (whole
    // object replaces global) beats settings.json. Re-routed through
    // the effective resolver in v2.15.1 so per-conception overrides
    // take effect app-wide. The shape is built from the bundled
    // defaults so missing keys never reach the renderer as undefined.
    const settings = await readSettings();
    let raw: Partial<CardMinWidthPrefs> | undefined = settings.cardMinWidth;
    if (settings.lastConceptionPath) {
      const effective = await getEffectiveConceptionConfig(settings.lastConceptionPath);
      if (effective.cardMinWidth) {
        raw = effective.cardMinWidth as Partial<CardMinWidthPrefs>;
      }
    }
    const out: Required<CardMinWidthPrefs> = { ...DEFAULT_CARD_MIN_WIDTH };
    for (const key of CARD_MIN_KEYS) {
      const v = raw?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return out;
  });

  ipcMain.handle('getTreeExpansion', async (event) => {
    requireMainWindowSender(event);
    const { treeExpansion } = await readSettings();
    const out: Required<Pick<TreeExpansionPrefs, TreeExpansionKey>> = {
      knowledge: [],
      resources: [],
      skills: [],
      skillsUser: [],
    };
    // Pre-reframe per-harness keys (`skillsGeneric`, `skillsClaude`,
    // `skillsKimi`, `skillsOpencode`) collapse into the single
    // `skills` (conception-scope) key. Take the union of all four
    // legacy keys + the canonical `skills` value so users keep their
    // expansion state on upgrade.
    const legacyExpansion = treeExpansion as
      | (TreeExpansionPrefs & {
          skillsGeneric?: unknown;
          skillsClaude?: unknown;
          skillsKimi?: unknown;
          skillsOpencode?: unknown;
        })
      | undefined;
    const legacyHarnessSources = legacyExpansion
      ? [
          legacyExpansion.skillsGeneric,
          legacyExpansion.skillsClaude,
          legacyExpansion.skillsKimi,
          legacyExpansion.skillsOpencode,
        ]
      : [];
    let hadLegacyHarnessKey = false;
    if (legacyHarnessSources.some((v) => Array.isArray(v))) {
      hadLegacyHarnessKey = true;
      const seen = new Set<string>();
      for (const candidate of legacyHarnessSources) {
        if (!Array.isArray(candidate)) continue;
        for (const entry of candidate) {
          if (typeof entry === 'string') seen.add(entry);
        }
      }
      out.skills = Array.from(seen);
    }
    for (const key of TREE_EXPANSION_KEYS) {
      const v = treeExpansion?.[key];
      if (Array.isArray(v)) {
        // Coerce to string + dedupe; filter anything that isn't a string
        // so a corrupt settings file can't crash the renderer.
        const seen = new Set<string>();
        for (const entry of v) {
          if (typeof entry === 'string') seen.add(entry);
        }
        // If `skills` is explicitly present alongside legacy harness keys,
        // the explicit value wins (legacy only fills the gap).
        if (seen.size > 0 || !(key === 'skills' && hadLegacyHarnessKey)) {
          out[key] = Array.from(seen);
        }
      }
    }
    // Opportunistically rewrite settings.json without the legacy
    // per-harness keys so they don't linger indefinitely for users who
    // never trigger a tree-expansion mutation. Fire-and-forget — failure
    // here is non-fatal and the next read will simply re-migrate.
    if (hadLegacyHarnessKey) {
      void updateSettings((cur) => {
        const curTreeExpansion = cur.treeExpansion as
          | (TreeExpansionPrefs & {
              skillsGeneric?: string[];
              skillsClaude?: string[];
              skillsKimi?: string[];
              skillsOpencode?: string[];
            })
          | undefined;
        if (!curTreeExpansion) return cur;
        const {
          skillsGeneric: _gen,
          skillsClaude: _claude,
          skillsKimi: _kimi,
          skillsOpencode: _opencode,
          ...rest
        } = curTreeExpansion;
        void _gen;
        void _claude;
        void _kimi;
        void _opencode;
        const merged: TreeExpansionPrefs = { ...rest };
        if (rest.skills === undefined && out.skills.length > 0) {
          merged.skills = out.skills;
        }
        return { ...cur, treeExpansion: merged };
      }).catch(() => undefined);
    }
    return out;
  });

  ipcMain.handle('setTreeExpansion', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const input = (raw ?? {}) as Record<string, unknown>;
    const allowed = new Set<string>(TREE_EXPANSION_KEYS);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new Error(`setTreeExpansion: unknown key ${JSON.stringify(key)}`);
      }
    }
    const sanitised: TreeExpansionPrefs = {};
    let nonEmpty = false;
    for (const key of TREE_EXPANSION_KEYS) {
      const v = input[key];
      if (!Array.isArray(v)) continue;
      const seen = new Set<string>();
      for (const entry of v) {
        if (typeof entry === 'string') seen.add(entry);
      }
      if (seen.size > 0) {
        sanitised[key] = Array.from(seen);
        nonEmpty = true;
      }
    }
    await updateSettings((cur) => ({
      ...cur,
      treeExpansion: nonEmpty ? sanitised : undefined,
    }));
  });

  ipcMain.handle('getSelectedBranches', async (event) => {
    requireMainWindowSender(event);
    const { selectedBranches } = await readSettings();
    if (!Array.isArray(selectedBranches)) return [] as string[];
    // Coerce + dedupe defensively in case a hand-edit corrupted the file.
    const seen = new Set<string>();
    for (const entry of selectedBranches) {
      if (typeof entry === 'string' && entry.length > 0) seen.add(entry);
    }
    return Array.from(seen);
  });

  ipcMain.handle('setSelectedBranches', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const arr = requireStringArray('setSelectedBranches', raw);
    const seen = new Set<string>();
    for (const entry of arr) {
      if (typeof entry === 'string' && entry.length > 0) seen.add(entry);
    }
    const next = Array.from(seen);
    await updateSettings((cur) => ({
      ...cur,
      // Drop the field entirely when empty so settings.json stays clean
      // and the on-purpose "nothing pinned" state matches a fresh install.
      selectedBranches: next.length > 0 ? next : undefined,
    }));
  });

  // Branch-pin sticky-all flag (issue #169). The getter applies the
  // backwards-compatibility default: when the field is undefined, assume
  // `true` if `selectedBranches` is empty/undefined (the user was relying
  // on the old "empty = show all" semantics) and `false` otherwise (they
  // had an explicit selection that should keep working).
  ipcMain.handle('getBranchFilterStickyAll', async (event) => {
    requireMainWindowSender(event);
    const { branchFilterStickyAll, selectedBranches } = await readSettings();
    if (typeof branchFilterStickyAll === 'boolean') return branchFilterStickyAll;
    const hasSelection = Array.isArray(selectedBranches) && selectedBranches.length > 0;
    return !hasSelection;
  });

  ipcMain.handle('setBranchFilterStickyAll', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const value = requireBoolean('setBranchFilterStickyAll', raw);
    await updateSettings((cur) => ({ ...cur, branchFilterStickyAll: value }));
  });

  // Skills-pane active scope (per-machine). Default is `conception` —
  // the pane opens to whatever this conception ships before flipping
  // to the user-scope agedum sources.
  ipcMain.handle('getSkillsActiveScope', async (event): Promise<SkillScope> => {
    requireMainWindowSender(event);
    const { skillsActiveScope } = await readSettings();
    if (
      typeof skillsActiveScope === 'string' &&
      SKILL_SCOPE_SET.has(skillsActiveScope as SkillScope)
    ) {
      return skillsActiveScope as SkillScope;
    }
    return 'conception';
  });

  ipcMain.handle('setSkillsActiveScope', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const scope = requireEnum('setSkillsActiveScope', raw, SKILL_SCOPE_SET);
    await updateSettings((cur) => ({ ...cur, skillsActiveScope: scope }));
  });

  ipcMain.handle('setCardMinWidth', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const input = (raw ?? {}) as Record<string, unknown>;
    // Reject unknown keys outright — silently dropping them used to mask
    // typos like `{ projets: 200 }` in renderer code.
    const allowed = new Set<string>(CARD_MIN_KEYS);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new Error(`setCardMinWidth: unknown key ${JSON.stringify(key)}`);
      }
    }
    const sanitised: CardMinWidthPrefs = {};
    for (const key of CARD_MIN_KEYS) {
      const v = clampMinWidth(input[key as CardKey]);
      if (v !== undefined) sanitised[key] = v;
    }
    const pruned = pruneDefaults(sanitised);
    await updateSettings((cur) => ({ ...cur, cardMinWidth: pruned }));
  });
}
