import { createHash } from 'node:crypto';
import { mkdirSync, promises as fs, realpathSync } from 'node:fs';
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
//
// The base is namespaced by checkout by default, because two gated suites run
// concurrently on one host whenever two worktrees push at once: sharing one
// base collided their fixtures (EEXIST/ENOENT noise across the recovery
// suites). `checkoutNamespace` hashes the checkout root — the vitest worker's
// cwd, symlink-resolved — into the leaf name, so every checkout owns its own
// base while one checkout always derives the same root across runs. CI's
// checkout sits at $GITHUB_WORKSPACE, so there the derivation yields one
// canonical root and the prescribed home chain is unchanged.
// `CONDASH_VITEST_RECOVERY_PARENT` keeps working as the explicit override
// (a test-host accommodation, e.g. a sandbox mounting the home root
// read-only); CI never sets it. When the env var is unset and the home root
// itself is not writable, the base falls back to the state directory under
// the same namespace (see resolveRecoveryBaseFor) so a gated push from such a
// host does not need the variable exported. The namespace removes the
// cross-worktree collision only; two concurrent runs from the same checkout
// still share a base and lean on the recovery machinery's own guards, which
// are deliberately untouched here.
//
// Each test file opens its own scope under the base: vitest may run test
// files in parallel workers, and force-recreating the whole base would race a
// concurrent worker's live fixtures. The wrapper base is removed best-effort
// on close — rmdir succeeds only when empty — so the last scope to finish
// leaves nothing behind, while a stale crashed run's leftovers are
// force-recreated when that scope next opens.
export const RECOVERY_TEST_PARENT_ENV = 'CONDASH_VITEST_RECOVERY_PARENT';

/**
 * Short filesystem-safe namespace for one checkout: two concurrent gated
 * suites on one host run from different worktree roots, so each checkout
 * hashes to its own fixture base, while the same checkout — CI's
 * $GITHUB_WORKSPACE included — always hashes to the same single root.
 */
export function checkoutNamespace(checkoutRoot: string): string {
  return createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 12);
}

/** Inputs the base resolution reads, injectable so tests can pin the shape. */
export interface RecoveryBaseInputs {
  env: NodeJS.ProcessEnv;
  checkoutRoot: string;
  homedir: string;
}

/**
 * Resolve the fixture base for the given inputs: an explicit
 * RECOVERY_TEST_PARENT_ENV value is used as-is, and if the test host points
 * it somewhere unusable, the suites fail loudly there on the first open —
 * which is the accommodation's contract. Otherwise the home chain, namespaced
 * by checkout; if the home root is not writable, the state chain.
 */
export function resolveRecoveryBaseFor({ env, checkoutRoot, homedir }: RecoveryBaseInputs): string {
  const explicit = env[RECOVERY_TEST_PARENT_ENV];
  if (explicit) return explicit;
  const namespace = checkoutNamespace(checkoutRoot);
  const homeBase = join(homedir, `.condash-recovery-vitest-${namespace}`);
  try {
    mkdirSync(homeBase, { recursive: true, mode: 0o700 });
    return homeBase;
  } catch {
    // A test host whose home root is not writable (e.g. an agent sandbox
    // mounting /home read-only) cannot hold the base; fall back to the
    // state directory, which such sandboxes keep writable. The ancestor
    // gate accepts the chain: every element is user-owned, and the base
    // itself is created 0700 below. If the fallback is unusable too, its
    // error surfaces — same loud failure as before, in a host where
    // neither location works.
    const stateBase = join(
      env.XDG_STATE_HOME ?? join(homedir, '.local', 'state'),
      `condash-recovery-vitest-${namespace}`,
    );
    mkdirSync(stateBase, { recursive: true, mode: 0o700 });
    return stateBase;
  }
}

// The default home base is resolved once per process: `open` and `close`
// must agree on where a scope lives, so a mid-run fallback decision cannot
// send open to one directory and close to another.
let cachedBase: string | undefined;

function base(): string {
  cachedBase ??= resolveRecoveryBaseFor({
    env: process.env,
    // The vitest worker's cwd is the checkout the suite runs from; resolve
    // symlinks so one checkout namespaces identically no matter how its
    // path is spelled. Resolved inside the same one-shot decision as the
    // base, so open and close cannot disagree mid-run.
    checkoutRoot: realpathSync(process.cwd()),
    homedir: homedir(),
  });
  return cachedBase;
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
