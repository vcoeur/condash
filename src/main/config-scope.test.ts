/**
 * `config-scope.ts` is the zod-free scope map extracted from `config-schema.ts`
 * (review finding S4) so the boot-path scope-partition migrator can import the
 * key → owning-file map without constructing the ~15 top-level zod schemas
 * (≈45 ms) at module load. This test locks the map's contents; the drift guard
 * against the actual strict schemas lives in `config-schema.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  CONCEPTION_ONLY_KEYS,
  GLOBAL_ONLY_KEYS,
  PATH_TRACKING_KEYS,
  SCOPE_OF,
  SKILLS_ACTIVE_SCOPE_KEY,
} from './config-scope';

describe('config-scope SCOPE_OF', () => {
  it('maps each conception-owned key to "conception"', () => {
    for (const key of CONCEPTION_ONLY_KEYS) {
      expect(SCOPE_OF[key]).toBe('conception');
    }
  });

  it('maps every global-owned key (incl. path-tracking + skills scope) to "global"', () => {
    for (const key of [...GLOBAL_ONLY_KEYS, ...PATH_TRACKING_KEYS, SKILLS_ACTIVE_SCOPE_KEY]) {
      expect(SCOPE_OF[key]).toBe('global');
    }
  });

  it('has disjoint conception/global key sets and no $schema_doc entry', () => {
    const conception = new Set<string>(CONCEPTION_ONLY_KEYS);
    const global = [...GLOBAL_ONLY_KEYS, ...PATH_TRACKING_KEYS, SKILLS_ACTIVE_SCOPE_KEY];
    for (const key of global) expect(conception.has(key)).toBe(false);
    expect('$schema_doc' in SCOPE_OF).toBe(false);
  });

  it('covers exactly the union of the two key groups', () => {
    const expected = new Set<string>([
      ...CONCEPTION_ONLY_KEYS,
      ...GLOBAL_ONLY_KEYS,
      ...PATH_TRACKING_KEYS,
      SKILLS_ACTIVE_SCOPE_KEY,
    ]);
    expect(new Set(Object.keys(SCOPE_OF))).toEqual(expected);
  });
});
