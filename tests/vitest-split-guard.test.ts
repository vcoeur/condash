/**
 * Guard for the split unit suite.
 *
 * The loop-delay timing tests run in a second `vitest run` under
 * `vitest.perf.config.ts` (see `PERF_LOOP_DELAY_TESTS` in `vitest.config.ts`
 * for why). That split has a failure mode the suite itself cannot show: if the
 * second invocation is dropped from `package.json` / the CI lane, or the files
 * are excluded from the main run without being included in the perf run, those
 * tests simply stop running and everything stays green.
 *
 * This test pins the wiring end to end — the files exist, the main config
 * excludes exactly them, the perf config includes exactly them, and both
 * invocations are still reachable from `npm run test:unit` and the fast lane.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import mainConfig, { PERF_LOOP_DELAY_TESTS } from '../vitest.config';
import perfConfig from '../vitest.perf.config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the split unit suite stays wired up', () => {
  it('every isolated test file exists', () => {
    expect(PERF_LOOP_DELAY_TESTS.length).toBeGreaterThan(0);
    for (const rel of PERF_LOOP_DELAY_TESTS) {
      expect(existsSync(join(ROOT, rel)), `${rel} is listed but missing on disk`).toBe(true);
    }
  });

  it('the main config excludes exactly the isolated files', () => {
    const exclude = mainConfig.test?.exclude ?? [];
    for (const rel of PERF_LOOP_DELAY_TESTS) {
      expect(exclude, `${rel} must be excluded from the main run`).toContain(rel);
    }
  });

  it('the perf config includes exactly the isolated files and runs them alone', () => {
    expect(perfConfig.test?.include).toEqual([...PERF_LOOP_DELAY_TESTS]);
    // Without this the second invocation would run its two files in parallel
    // with each other, which is the contention the split exists to remove.
    expect(perfConfig.test?.fileParallelism).toBe(false);
  });

  it('npm run test:unit invokes both configs', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts['test:unit'];
    expect(script, 'test:unit must run the perf config as a second invocation').toContain(
      'vitest.perf.config.ts',
    );
  });

  it('the CI fast lane runs test:unit, not a bare vitest run', () => {
    const lane = readFileSync(join(ROOT, '.github', 'workflows', '_fast.yml'), 'utf8');
    expect(lane).toContain('npm run test:unit');
    // A bare `vitest run` in the lane would cover only the main half.
    expect(lane).not.toMatch(/run:\s*npx vitest run\s*$/m);
  });
});
