import { ipcMain } from 'electron';
import { toPosix } from '../../shared/path';
import { getEffectiveConceptionConfig } from '../effective-config';
import { DEFAULT_LAYOUT, readSettings, settingsPath, updateSettings } from '../settings';
import type {
  CardMinWidthPrefs,
  LayoutState,
  ProjectCardTitleFont,
  Settings,
  SkillScope,
  Theme,
  TreeExpansionPrefs,
} from '../../shared/types';
import {
  CARD_MIN_WIDTH_KEYS,
  DEFAULT_CARD_MIN_WIDTH,
  DEFAULT_PROJECT_CARD_TITLE_FONT,
  SKILL_SCOPES,
} from '../../shared/types';
import {
  requireBoolean,
  requireEnum,
  requireMainWindowSender,
  requireOptionalRecord,
  requireStringArray,
} from './utils';

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

// --- Value resolvers ----------------------------------------------------
// Each getter's computation is extracted into a pure(-ish) resolver over an
// already-read `Settings` so the `bootstrap` IPC (ipc/bootstrap.ts) can assemble
// the whole mount-time bundle from ONE `readSettings()` instead of ~9 separate
// getter round-trips, each re-reading settings.json. The individual `get*`
// handlers below call the same resolvers, so the two paths can never diverge.

/** Effective theme. `theme` is a global-only key (there is no conception
 *  override), so this resolves to the global `settings.theme` — read through
 *  `getEffectiveConceptionConfig` only to keep one settings read surface.
 *  Mirrors the `getTheme` handler. */
export async function resolveTheme(settings: Settings): Promise<Theme> {
  if (settings.lastConceptionPath) {
    const effective = await getEffectiveConceptionConfig(settings.lastConceptionPath);
    if (effective.theme) return effective.theme as Theme;
  }
  return settings.theme;
}

/** Effective project-card title font. Global-only, but read through the same
 *  effective-config surface as `resolveTheme` so the bootstrap bundle takes
 *  one settings read. Falls back to the built-in editorial default when unset.
 *  Mirrors the theme resolver; there is no narrow `get*` handler — the value is
 *  read only at boot and re-applied from the Settings modal's live callback. */
export async function resolveProjectCardTitleFont(
  settings: Settings,
): Promise<ProjectCardTitleFont> {
  if (settings.lastConceptionPath) {
    const effective = await getEffectiveConceptionConfig(settings.lastConceptionPath);
    if (effective.projectCardTitleFont) return effective.projectCardTitleFont;
  }
  return settings.projectCardTitleFont ?? DEFAULT_PROJECT_CARD_TITLE_FONT;
}

/** Persisted composite layout, or the built-in default. Mirrors `getLayout`. */
export function resolveLayout(settings: Settings): LayoutState {
  return settings.layout ?? DEFAULT_LAYOUT;
}

/** Whether the first-launch welcome screen was dismissed. Mirrors
 *  `getWelcomeDismissed`. */
export function resolveWelcomeDismissed(settings: Settings): boolean {
  return settings.welcome?.dismissed === true;
}

/** Fully-resolved per-pane card min-widths, every key filled from the defaults.
 *  `cardMinWidth` is a global-only key (no conception override); the effective
 *  read returns the global value. Mirrors `getCardMinWidth`. */
export async function resolveCardMinWidth(
  settings: Settings,
): Promise<Required<CardMinWidthPrefs>> {
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
}

/** Per-pane tree-expansion sets with the legacy per-harness `skills*` keys
 *  folded into the single `skills` key. Opportunistically rewrites settings.json
 *  to drop the legacy keys (fire-and-forget). Mirrors `getTreeExpansion`. */
export function resolveTreeExpansion(settings: Settings): Required<TreeExpansionPrefs> {
  const { treeExpansion } = settings;
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
}

/** Pinned branch names, coerced + deduped. Mirrors `getSelectedBranches`. */
export function resolveSelectedBranches(settings: Settings): string[] {
  const { selectedBranches } = settings;
  if (!Array.isArray(selectedBranches)) return [];
  const seen = new Set<string>();
  for (const entry of selectedBranches) {
    if (typeof entry === 'string' && entry.length > 0) seen.add(entry);
  }
  return Array.from(seen);
}

/** Branch-pin "All (sticky)" mode with the back-compat default. Mirrors
 *  `getBranchFilterStickyAll`. */
export function resolveBranchFilterStickyAll(settings: Settings): boolean {
  const { branchFilterStickyAll, selectedBranches } = settings;
  if (typeof branchFilterStickyAll === 'boolean') return branchFilterStickyAll;
  const hasSelection = Array.isArray(selectedBranches) && selectedBranches.length > 0;
  return !hasSelection;
}

/** Skills-pane active scope, validated, default `conception`. Mirrors
 *  `getSkillsActiveScope`. */
export function resolveSkillsActiveScope(settings: Settings): SkillScope {
  const { skillsActiveScope } = settings;
  if (
    typeof skillsActiveScope === 'string' &&
    SKILL_SCOPE_SET.has(skillsActiveScope as SkillScope)
  ) {
    return skillsActiveScope as SkillScope;
  }
  return 'conception';
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
    // `theme` is a global-only key — no conception override — so this returns
    // the global `settings.theme` (falling back to 'system' when unset).
    // See resolveTheme.
    return resolveTheme(await readSettings());
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
    return resolveLayout(await readSettings());
  });

  ipcMain.handle('setLayout', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    // Same shape check the settings save path enforces — keeps the IPC trust
    // boundary uniform with the shared decoders used by the other setters.
    // `config-schema` (≈45 ms of zod construction) is dynamic-imported here so
    // this write-path handler is the only thing that pulls it — the pre-window
    // boot graph stays zod-free (mirrors the CLI's config read/write split).
    const { layoutSchema } = await import('../config-schema');
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
    return resolveWelcomeDismissed(await readSettings());
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
    // `cardMinWidth` is a global-only key — no conception override. The shape
    // is built from the bundled defaults so missing keys never reach the
    // renderer as undefined. See resolveCardMinWidth.
    return resolveCardMinWidth(await readSettings());
  });

  ipcMain.handle('getTreeExpansion', async (event) => {
    requireMainWindowSender(event);
    return resolveTreeExpansion(await readSettings());
  });

  ipcMain.handle('setTreeExpansion', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const input = requireOptionalRecord('setTreeExpansion', raw) ?? {};
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
    return resolveSelectedBranches(await readSettings());
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
    return resolveBranchFilterStickyAll(await readSettings());
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
    return resolveSkillsActiveScope(await readSettings());
  });

  ipcMain.handle('setSkillsActiveScope', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const scope = requireEnum('setSkillsActiveScope', raw, SKILL_SCOPE_SET);
    await updateSettings((cur) => ({ ...cur, skillsActiveScope: scope }));
  });

  ipcMain.handle('setCardMinWidth', async (event, raw: unknown) => {
    requireMainWindowSender(event);
    const input = requireOptionalRecord('setCardMinWidth', raw) ?? {};
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
