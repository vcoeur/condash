import { describe, expect, it } from 'vitest';
import { globalSettingsSchema, conceptionConfigSchema } from '../../main/config-schema';
import { RAW_CONFIG_KEYS, SECTION_KEYS } from './data';

/**
 * Parity guard for the renderer's hand-mirror of the two zod config schemas.
 *
 * The renderer can't import zod, so `RawConfig` + `SECTION_KEYS` in `data.ts`
 * re-declare, by hand, the keys of `globalSettingsSchema` /
 * `conceptionConfigSchema`. Main-side, that drift class is double-guarded (the
 * `satisfies Record<keyof …>` clauses on the field groups + `config-schema.test.ts`).
 * The renderer mirror had neither guard — so a new schema key that never reached
 * `RawConfig` (or reached it but landed in no Settings section) silently vanished
 * from the Settings modal. That exact failure shipped twice. This test is the
 * missing guard: node-env vitest can import both the main zod schemas and the
 * renderer data module, so it asserts the two stay in sync and forces every
 * deliberate omission to be an explicit, reasoned allowlist entry.
 */

// Schema keys deliberately NOT surfaced through the Settings modal's RawConfig.
// A new schema key must either appear in RawConfig or be justified here.
const SCHEMA_KEYS_NOT_IN_RAWCONFIG = new Map<string, string>([
  ['retired_apps', 'edited via `condash applications`, not the Settings modal'],
  ['taskConfig', 'edited in the Tasks pane, not Settings'],
  ['layout', 'UI-state condash manages itself (pane visibility + sizes)'],
  ['welcome', 'first-launch dismissed flag, set programmatically'],
  ['treeExpansion', 'UI-state (per-pane expanded directories)'],
  ['selectedBranches', 'UI-state (Code-pane branch filter selection)'],
  ['branchFilterStickyAll', 'UI-state (Code-pane branch filter mode)'],
  ['skillsActiveScope', 'UI-state (Skills pane active scope)'],
]);

// RawConfig keys deliberately NOT owned by any editable Settings section.
const RAWCONFIG_KEYS_WITHOUT_SECTION = new Map<string, string>([
  ['$schema_doc', 'documentation pointer, not a setting'],
  ['pdf_viewer', 'carried for lossless round-trip; no dedicated section yet'],
  ['lastConceptionPath', 'path-tracking, never hand-edited in a section'],
  ['recentConceptionPaths', 'path-tracking, managed by the recents section'],
]);

describe('Settings RawConfig ↔ config-schema parity', () => {
  const schemaKeys = new Set<string>([
    ...Object.keys(globalSettingsSchema.shape),
    ...Object.keys(conceptionConfigSchema.shape),
  ]);
  const rawConfigKeys = new Set<string>(RAW_CONFIG_KEYS);
  const bucketedKeys = new Set<string>(Object.values(SECTION_KEYS).flat() as string[]);

  it('every config-schema key appears in RawConfig (or is explicitly allowlisted)', () => {
    for (const key of schemaKeys) {
      if (rawConfigKeys.has(key) || SCHEMA_KEYS_NOT_IN_RAWCONFIG.has(key)) continue;
      throw new Error(
        `Config-schema key "${key}" is missing from RawConfig in settings-modal-parts/data.ts. ` +
          `Add it to RawConfig + RAW_CONFIG_KEYS so it round-trips through Settings, or ` +
          `allowlist it in SCHEMA_KEYS_NOT_IN_RAWCONFIG with a reason.`,
      );
    }
  });

  it('every RawConfig key lands in a SECTION_KEYS bucket (or is explicitly allowlisted)', () => {
    for (const key of RAW_CONFIG_KEYS) {
      if (bucketedKeys.has(key) || RAWCONFIG_KEYS_WITHOUT_SECTION.has(key)) continue;
      throw new Error(
        `RawConfig key "${key}" is in no SECTION_KEYS bucket — a section editing it would never ` +
          `render it. Add it to a SECTION_KEYS section, or allowlist it in ` +
          `RAWCONFIG_KEYS_WITHOUT_SECTION with a reason.`,
      );
    }
  });

  it('SECTION_KEYS only references real RawConfig keys', () => {
    for (const key of bucketedKeys) {
      expect(
        rawConfigKeys.has(key),
        `SECTION_KEYS references "${key}" which is not a RawConfig key`,
      ).toBe(true);
    }
  });

  it('the allowlists carry no stale entries', () => {
    // A key that graduated into RawConfig / a section must be dropped from its
    // allowlist, or the allowlist rots into a rubber stamp.
    for (const key of SCHEMA_KEYS_NOT_IN_RAWCONFIG.keys()) {
      expect(
        rawConfigKeys.has(key),
        `"${key}" is now in RawConfig — drop it from SCHEMA_KEYS_NOT_IN_RAWCONFIG`,
      ).toBe(false);
    }
    for (const key of RAWCONFIG_KEYS_WITHOUT_SECTION.keys()) {
      expect(
        bucketedKeys.has(key),
        `"${key}" is now in a SECTION_KEYS bucket — drop it from RAWCONFIG_KEYS_WITHOUT_SECTION`,
      ).toBe(false);
    }
  });
});
