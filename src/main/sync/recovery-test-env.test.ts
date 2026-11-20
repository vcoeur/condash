import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutNamespace,
  RECOVERY_TEST_PARENT_ENV,
  resolveRecoveryBaseFor,
} from './recovery-test-env';

// The fixture base derivation: an explicit CONDASH_VITEST_RECOVERY_PARENT
// wins, otherwise the home chain under a per-checkout namespace, falling back
// to the state chain only when the home root is unwritable. The shape matters
// to CI parity: the recovery suites' private 0700 base must stay in the home
// chain there, derived from the single $GITHUB_WORKSPACE checkout.
describe('the recovery fixture base derivation', () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      rmSync(scratch.pop()!, { recursive: true, force: true });
    }
  });

  function fakeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'recovery-base-home-'));
    scratch.push(home);
    return home;
  }

  it('two different checkout paths derive different bases; one path derives the same base twice', () => {
    const home = fakeHome();
    const one = resolveRecoveryBaseFor({
      env: {},
      checkoutRoot: '/src/worktrees/one/condash',
      homedir: home,
    });
    const two = resolveRecoveryBaseFor({
      env: {},
      checkoutRoot: '/src/worktrees/two/condash',
      homedir: home,
    });
    expect(one).not.toBe(two);
    expect(one).toBe(
      resolveRecoveryBaseFor({
        env: {},
        checkoutRoot: '/src/worktrees/one/condash',
        homedir: home,
      }),
    );
  });

  it('an explicit env var wins over the derived namespace, as-is', () => {
    const base = resolveRecoveryBaseFor({
      env: { [RECOVERY_TEST_PARENT_ENV]: '/explicit/parent' },
      checkoutRoot: '/src/worktrees/one/condash',
      homedir: fakeHome(),
    });
    expect(base).toBe('/explicit/parent');
  });

  it('a CI-shaped checkout keeps one canonical private base in the home chain', () => {
    const home = fakeHome();
    const workspace = '/home/runner/work/condash/condash';
    const inputs = { env: { GITHUB_WORKSPACE: workspace }, checkoutRoot: workspace, homedir: home };
    const base = resolveRecoveryBaseFor(inputs);
    // Still the prescribed home chain — the state fallback is not taken —
    // and still a private 0700 base the recovery ancestor gate accepts.
    expect(base.startsWith(home)).toBe(true);
    expect(statSync(base).mode & 0o777).toBe(0o700);
    // One canonical root: the same workspace derives the same base again,
    // and a concurrent suite from a different checkout cannot share it.
    expect(resolveRecoveryBaseFor(inputs)).toBe(base);
    expect(base).not.toBe(
      resolveRecoveryBaseFor({
        env: { GITHUB_WORKSPACE: workspace },
        checkoutRoot: join(workspace, '..', 'condash-sibling'),
        homedir: home,
      }),
    );
  });

  it('an unwritable home root falls back to the state chain under the same namespace', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'recovery-base-fallback-'));
    scratch.push(scratchRoot);
    // A homedir that is a regular file cannot hold the base, the way an
    // agent sandbox mounting /home read-only cannot; the state chain takes
    // over, namespaced by the same checkout hash.
    const fileHome = join(scratchRoot, 'not-a-directory');
    writeFileSync(fileHome, '');
    const state = join(scratchRoot, 'state');
    const base = resolveRecoveryBaseFor({
      env: { XDG_STATE_HOME: state },
      checkoutRoot: '/src/worktrees/one/condash',
      homedir: fileHome,
    });
    expect(base).toBe(
      join(state, `condash-recovery-vitest-${checkoutNamespace('/src/worktrees/one/condash')}`),
    );
  });
});
