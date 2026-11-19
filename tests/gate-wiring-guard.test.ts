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
    // The env check itself, not the bare variable name — the failure-path
    // message also mentions CONDASH_SKIP_GATE, so a substring match stays
    // green if only the check disappears.
    expect(hook).toMatch(/\[ "\$\{CONDASH_SKIP_GATE:-\}" = "1" \]/);
    // The hook must consume git's stdin ref lines and skip only when every
    // line is a no-op or deletion (deletion: all-zero local sha; no-op:
    // remote sha equals local sha) — a mixed push that sends commits runs
    // the gate.
    expect(hook).toMatch(/while read -r/);
    expect(hook).toMatch(/sends_commits=0/);
    expect(hook).toContain('make gate');
    // Git exports its repo handoff (GIT_DIR pointing at this worktree's
    // gitdir, GIT_CONFIG_PARAMETERS, ...) to hooks, and a child git
    // resolves its repo from those variables instead of its cwd — the
    // gate's test fixtures spawn git with explicit cwd and would all land
    // in the real repo. The hook must strip the handoff before `make gate`
    // (2026-11-19: without the unset, a gated push's vitest run appended
    // fixture commits to the branch being pushed).
    expect(hook).toMatch(/unset GIT_DIR/);
    // Assert against the unset command itself, not bare names: the hook's
    // comment also names some of these variables, and a name kept only in
    // the comment must not keep this guard green.
    const unsetBlock = hook.match(/unset GIT_DIR[\s\S]*?GIT_PREFIX\s*$/m)?.[0] ?? '';
    expect(unsetBlock).not.toBe('');
    for (const envVar of [
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_CONFIG_PARAMETERS',
    ]) {
      expect(unsetBlock).toContain(envVar);
    }
  });

  it('the docs describe the hook, its skip variable and the umask rationale', () => {
    expect(devLaunch).toContain('## Pre-push gate');
    expect(devLaunch).toContain('CONDASH_SKIP_GATE');
    expect(devLaunch).toContain('umask 022');
    expect(devLaunch).toContain('core.hooksPath');
  });

  it('test-unit pins the npm script so the local gate cannot drift from CI', () => {
    // Defense in depth: CI's test-unit invocation is separately pinned by
    // tests/vitest-split-guard.test.ts; this pins the Makefile recipe the
    // gate calls.
    expect(makefile).toMatch(/^test-unit:\n\tnpm run test:unit$/m);
  });
});
