import { ipcMain } from 'electron';
import { toPosix } from '../../shared/path';
import { getEffectiveConceptionConfig } from '../effective-config';
import { DEFAULT_LAYOUT, readSettings, settingsPath, updateSettings } from '../settings';
import type {
  CardMinWidthPrefs,
  LayoutState,
  SkillScope,
  SkillTab,
  Theme,
  TreeExpansionPrefs,
} from '../../shared/types';
import { DEFAULT_CARD_MIN_WIDTH, SKILL_SCOPES, SKILL_TABS } from '../../shared/types';

// Note: the legacy `skills` key is accepted on read (migrated to
// `skillsClaude`) but never written back. New writers emit the three
// per-tab keys.
const TREE_EXPANSION_KEYS = [
  'knowledge',
  'resources',
  'skillsGeneric',
  'skillsClaude',
  'skillsKimi',
] as const;
type TreeExpansionKey = (typeof TREE_EXPANSION_KEYS)[number];

const SKILL_TAB_SET: ReadonlySet<SkillTab> = new Set(SKILL_TABS);

const SKILL_SCOPE_SET: ReadonlySet<SkillScope> = new Set(SKILL_SCOPES);

const THEMES: ReadonlySet<Theme> = new Set(['light', 'dark', 'system']);

const CARD_MIN_KEYS = ['projects', 'code', 'knowledge', 'resources', 'skills'] as const;
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
  ipcMain.handle('getTheme', async () => {
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

  ipcMain.handle('getSettingsPath', () => toPosix(settingsPath()));

  ipcMain.handle('setTheme', async (_, theme: Theme) => {
    if (!THEMES.has(theme)) throw new Error(`Unknown theme: ${theme}`);
    await updateSettings((cur) => ({ ...cur, theme }));
  });

  ipcMain.handle('getLayout', async () => {
    const { layout } = await readSettings();
    return layout ?? DEFAULT_LAYOUT;
  });

  ipcMain.handle('setLayout', async (_, layout: LayoutState) => {
    await updateSettings((cur) => ({ ...cur, layout }));
    opts.onLayoutChange(layout);
  });

  ipcMain.handle('getWelcomeDismissed', async () => {
    const { welcome } = await readSettings();
    return welcome?.dismissed === true;
  });

  ipcMain.handle('setWelcomeDismissed', async (_, value: boolean) => {
    await updateSettings((cur) => ({
      ...cur,
      welcome: { ...(cur.welcome ?? {}), dismissed: value },
    }));
  });

  ipcMain.handle('getCardMinWidth', async () => {
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

  ipcMain.handle('getTreeExpansion', async () => {
    const { treeExpansion } = await readSettings();
    const out: Required<Pick<TreeExpansionPrefs, TreeExpansionKey>> = {
      knowledge: [],
      resources: [],
      skillsGeneric: [],
      skillsClaude: [],
      skillsKimi: [],
    };
    // Legacy `skills` key migrates into `skillsClaude` so users keep their
    // existing expansion state when the tabs ship for the first time.
    const legacySkills = Array.isArray(treeExpansion?.skills) ? treeExpansion.skills : null;
    if (legacySkills) {
      const seen = new Set<string>();
      for (const entry of legacySkills) {
        if (typeof entry === 'string') seen.add(entry);
      }
      out.skillsClaude = Array.from(seen);
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
        out[key] = Array.from(seen);
      }
    }
    // Opportunistically rewrite settings.json without the legacy `skills`
    // key so it doesn't linger indefinitely for users who never trigger a
    // tree-expansion mutation. Fire-and-forget — failure here is non-fatal
    // and the next read will simply re-migrate.
    //
    // The mutator re-reads `cur.treeExpansion` under `withSettingsQueue`
    // rather than reusing the outer snapshot, so a parallel
    // `setTreeExpansion` that landed between our read and this mutator
    // running is preserved instead of being clobbered with stale state.
    if (legacySkills) {
      void updateSettings((cur) => {
        const curTreeExpansion = cur.treeExpansion;
        // Another mutator already dropped the legacy key — nothing to do.
        if (!curTreeExpansion?.skills) return cur;
        const { skills: legacyOnDisk, ...rest } = curTreeExpansion;
        const migrated = new Set<string>();
        for (const entry of Array.isArray(legacyOnDisk) ? legacyOnDisk : []) {
          if (typeof entry === 'string') migrated.add(entry);
        }
        // Explicit `skillsClaude` (if any) wins; legacy only fills the gap.
        const skillsClaude =
          rest.skillsClaude ?? (migrated.size > 0 ? Array.from(migrated) : undefined);
        const merged: TreeExpansionPrefs = { ...rest };
        if (skillsClaude !== undefined) merged.skillsClaude = skillsClaude;
        return { ...cur, treeExpansion: merged };
      }).catch(() => undefined);
    }
    return out;
  });

  ipcMain.handle('setTreeExpansion', async (_, raw: unknown) => {
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
    // Always drop the legacy `skills` key on write — the read path has
    // already migrated it to `skillsClaude`.
    await updateSettings((cur) => ({
      ...cur,
      treeExpansion: nonEmpty ? sanitised : undefined,
    }));
  });

  ipcMain.handle('getSelectedBranches', async () => {
    const { selectedBranches } = await readSettings();
    if (!Array.isArray(selectedBranches)) return [] as string[];
    // Coerce + dedupe defensively in case a hand-edit corrupted the file.
    const seen = new Set<string>();
    for (const entry of selectedBranches) {
      if (typeof entry === 'string' && entry.length > 0) seen.add(entry);
    }
    return Array.from(seen);
  });

  ipcMain.handle('setSelectedBranches', async (_, raw: unknown) => {
    if (!Array.isArray(raw)) {
      throw new Error('setSelectedBranches: expected array of strings');
    }
    const seen = new Set<string>();
    for (const entry of raw) {
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
  ipcMain.handle('getBranchFilterStickyAll', async () => {
    const { branchFilterStickyAll, selectedBranches } = await readSettings();
    if (typeof branchFilterStickyAll === 'boolean') return branchFilterStickyAll;
    const hasSelection = Array.isArray(selectedBranches) && selectedBranches.length > 0;
    return !hasSelection;
  });

  ipcMain.handle('setBranchFilterStickyAll', async (_, raw: unknown) => {
    if (typeof raw !== 'boolean') {
      throw new Error('setBranchFilterStickyAll: expected boolean');
    }
    await updateSettings((cur) => ({ ...cur, branchFilterStickyAll: raw }));
  });

  // Skills-pane active tab (per-machine). Default is `claude` — preserves
  // the pre-tabs behaviour for existing users.
  ipcMain.handle('getSkillsActiveTab', async (): Promise<SkillTab> => {
    const { skillsActiveTab } = await readSettings();
    if (typeof skillsActiveTab === 'string' && SKILL_TAB_SET.has(skillsActiveTab as SkillTab)) {
      return skillsActiveTab as SkillTab;
    }
    return 'claude';
  });

  ipcMain.handle('setSkillsActiveTab', async (_, raw: unknown) => {
    if (typeof raw !== 'string' || !SKILL_TAB_SET.has(raw as SkillTab)) {
      throw new Error('setSkillsActiveTab: expected generic | claude | kimi');
    }
    await updateSettings((cur) => ({ ...cur, skillsActiveTab: raw as SkillTab }));
  });

  // Skills-pane active scope (per-machine). Default is `local` — preserves
  // the conception-only behaviour for existing users.
  ipcMain.handle('getSkillsActiveScope', async (): Promise<SkillScope> => {
    const { skillsActiveScope } = await readSettings();
    if (
      typeof skillsActiveScope === 'string' &&
      SKILL_SCOPE_SET.has(skillsActiveScope as SkillScope)
    ) {
      return skillsActiveScope as SkillScope;
    }
    return 'local';
  });

  ipcMain.handle('setSkillsActiveScope', async (_, raw: unknown) => {
    if (typeof raw !== 'string' || !SKILL_SCOPE_SET.has(raw as SkillScope)) {
      throw new Error('setSkillsActiveScope: expected local | global');
    }
    await updateSettings((cur) => ({ ...cur, skillsActiveScope: raw as SkillScope }));
  });

  ipcMain.handle('setCardMinWidth', async (_, raw: unknown) => {
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
