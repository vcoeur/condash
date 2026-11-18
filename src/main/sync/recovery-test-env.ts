import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The recovery journal's ancestor gate (`directoryChain`) refuses a journal
// root whose chain contains a world-writable or foreign-owned ancestor —
// designed production protection for a journal about to be trusted. CI's /tmp
// is the standard 1777 sticky, so fixtures rooted at os.tmpdir() are refused
// before any fault can be injected (PR #622: 152/194 failures in
// index-recovery.test.ts, then 22/92 in run.test.ts); a dev host's nonstandard
// 755 /tmp masks the same way its umask masked the 0644 gate. Recovery-
// activating fixtures must therefore live under a private 0700 parent in the
// home directory, whose chain passes the gate on every CI-like layout: `/` and
// `/home` are root-owned (equal to the filesystem root's systemUid, so the
// gate accepts them) and `/home/<runner>` is runner-owned.
// `CONDASH_VITEST_RECOVERY_PARENT` is a test-host accommodation only (e.g. a
// sandbox mounting the home root read-only); CI never sets it, so CI always
// exercises the prescribed home chain.
//
// Each test file opens its own scope under the base: vitest may run test
// files in parallel workers, and force-recreating the whole base would race a
// concurrent worker's live fixtures. The wrapper base is removed best-effort
// on close — rmdir succeeds only when empty — so the last scope to finish
// leaves nothing behind, while a stale crashed run's leftovers are
// force-recreated when that scope next opens.
export const RECOVERY_TEST_PARENT_ENV = 'CONDASH_VITEST_RECOVERY_PARENT';

function base(): string {
  return process.env[RECOVERY_TEST_PARENT_ENV] ?? join(homedir(), '.condash-recovery-vitest');
}

/** Where a scope's mkdtemp fixtures root; only meaningful while open. */
export function recoveryFixtureParent(scope: string): string {
  return join(base(), scope);
}

/** Recreate a scope's fixture parent empty, private, and under a 0700 base. */
export async function openRecoveryFixtureParent(scope: string): Promise<string> {
  const parent = recoveryFixtureParent(scope);
  await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(base(), { recursive: true, mode: 0o700 });
  await fs.chmod(base(), 0o700).catch(() => {});
  await fs.mkdir(parent, { mode: 0o700 });
  return parent;
}

/** Remove a scope's fixtures, then the wrapper base when no scope holds it. */
export async function closeRecoveryFixtureParent(scope: string): Promise<void> {
  await fs.rm(recoveryFixtureParent(scope), { recursive: true, force: true }).catch(() => {});
  await fs.rmdir(base()).catch(() => {});
}
