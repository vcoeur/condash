/**
 * Guard for the local pre-push gate wiring.
 *
 * `make gate` mirrors the CI fast lane (`.github/workflows/_fast.yml`) and
 * `.githooks/pre-push` runs it before every push. The gate has the same
 * silent-decay failure mode the split-suite split guard exists for: if the
 * Makefile target is renamed away, the hook loses its skip semantics, or the
 * docs stop describing the wiring, everything still reports green — the gate
 * just stops running, and CI becomes the first environment to discover a
 * failure again. This test pins the wiring end to end.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf8');
const hook = readFileSync(join(ROOT, '.githooks', 'pre-push'), 'utf8');
const devLaunch = readFileSync(join(ROOT, 'docs', 'guides', 'dev-launch.md'), 'utf8');

describe('the pre-push gate stays wired up', () => {
  it('the Makefile declares gate and hooks, and gate mirrors the fast lane', () => {
    expect(makefile).toMatch(/^gate:/m);
    expect(makefile).toMatch(/^hooks:/m);
    // The five _fast.yml steps, in lane order, reached through the same
    // targets the lane's steps call.
    for (const step of ['format-check', 'typecheck', 'build', 'test-unit', 'deadcode']) {
      expect(makefile).toContain(`$(MAKE) ${step}`);
    }
    // The umask is the load-bearing part: under the ambient dev umask the
    // gate re-creates the masking it exists to catch.
    expect(makefile).toMatch(/gate:\n\tumask 022 /);
  });

  it('.githooks/pre-push exists, is executable, and keeps its skip semantics', () => {
    expect(existsSync(join(ROOT, '.githooks', 'pre-push'))).toBe(true);
    // Git only records the executable bit, but the hook must carry it or
    // git refuses to run it ("cannot run .githooks/pre-push: Permission
    // denied") and the push proceeds ungated.
    expect(statSync(join(ROOT, '.githooks', 'pre-push')).mode & 0o111).not.toBe(0);
    expect(hook).toContain('CONDASH_SKIP_GATE');
    // The hook must consume git's stdin ref lines and skip when nothing new
    // is sent (deletion: null new sha; no-op: remote sha equals new sha).
    expect(hook).toMatch(/while read -r/);
    expect(hook).toContain('make gate');
  });

  it('the docs describe the hook, its skip variable and the umask rationale', () => {
    expect(devLaunch).toContain('## Pre-push gate');
    expect(devLaunch).toContain('CONDASH_SKIP_GATE');
    expect(devLaunch).toContain('umask 022');
    expect(devLaunch).toContain('core.hooksPath');
  });
});
