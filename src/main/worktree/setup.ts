/**
 * `setup` mutator — creates per-repo worktrees for every app declared by
 * items on the target branch, applying per-repo `env:` and `install:` from
 * `condash.json`.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { exec } from '../exec';
import { pathExists } from '../fs-helpers';
import {
  branchExists,
  branchToDir,
  currentBranch,
  defaultWorktreesPath,
  findItemsDeclaringBranch,
  findWorktreeEntry,
  listWorktreeEntries,
  readConfig,
  refExists,
  repoLookupMap,
  resolveTargetRepos,
  validateBranchName,
  type RepoLookupExtended,
} from './shared';

export interface SetupOptions {
  /** Optional explicit repo allow-list (overrides Apps-derivation). */
  repos?: string[];
  /** Legacy opportunistic copy of `.env` / `.env.local` from the primary
   *  into the new worktree. Repos with `env:` declared in
   *  `condash.json` always have those files copied; this flag only
   *  affects repos *without* an `env:` declaration. */
  copyEnv?: boolean;
  /** Skip env-file copy for repos that declare `env:` in condash.json —
   *  both on creation and on the already-present backfill. Per-repo `env:`
   *  is otherwise applied unconditionally. Closes #87, #450. */
  skipEnv?: boolean;
  /** Skip running the per-repo `install:` from condash.json. The
   *  install step otherwise runs unconditionally for repos that declare
   *  `install:`. Closes #87. */
  skipInstall?: boolean;
  /** Explicit base branch override; takes precedence over README `**Base**`. */
  base?: string;
}

export interface SetupResult {
  branch: string;
  /** Repos we actually created worktrees for (skipping ones that already existed). */
  created: { repo: string; path: string }[];
  /** Repos we skipped because the worktree already existed on this branch. */
  alreadyPresent: { repo: string; path: string }[];
  /** Repos we couldn't set up — primary checkout already on the branch, a
   *  flattened-path collision with another branch's worktree, etc. */
  blocked: { repo: string; reason: string }[];
  /** `.env` files copied (relative to the worktree root) — on creation, and
   *  on the non-clobbering backfill into an already-present worktree. Only
   *  files actually written are listed, so a backfill that found everything
   *  already in place contributes no entry. */
  envCopied: { repo: string; files: string[] }[];
  /** Install commands run. `stderrTail` carries the last few stderr lines
   *  when the command failed, so a FAILED row is diagnosable. */
  installRan: { repo: string; command: string; ok: boolean; stderrTail?: string }[];
  /** Base ref new branches were created from (null when no base was resolved;
   *  each repo then branches from its default-branch tip — `origin/HEAD`,
   *  falling back to local `main`/`master`, falling back to the primary
   *  checkout's HEAD). */
  base: string | null;
  /** Stale-base warnings: for each repo where the start ref of a NEW branch
   *  has an upstream, how many commits the ref trails that (already-fetched)
   *  remote-tracking ref. No fetch is run — this only measures locally. */
  baseBehind: { repo: string; ref: string; upstream: string; behind: number }[];
}

export async function setupBranchWorktrees(
  conceptionPath: string,
  branch: string,
  options: SetupOptions = {},
): Promise<SetupResult> {
  validateBranchName(branch);
  const config = await readConfig(conceptionPath);
  const worktreesRoot = config.worktrees_path ?? defaultWorktreesPath();
  const reposByName = repoLookupMap(config);
  const wanted = await resolveTargetRepos(conceptionPath, branch, options.repos, reposByName);

  // Resolve the base ref: explicit --base wins; otherwise read **Base** from
  // every item declaring this branch and require unanimity. Disagreement is a
  // hard error — silently picking one would mask the misconfiguration.
  const declaring = await findItemsDeclaringBranch(conceptionPath, branch);
  const base = resolveBase(branch, options.base, declaring);

  const result: SetupResult = {
    branch,
    created: [],
    alreadyPresent: [],
    blocked: [],
    envCopied: [],
    installRan: [],
    base: base ?? null,
    baseBehind: [],
  };

  const branchDir = branchToDir(branch);
  await fs.mkdir(join(worktreesRoot, branchDir), { recursive: true });

  for (const name of wanted) {
    const lookup = reposByName.get(name);
    if (!lookup) {
      result.blocked.push({ repo: name, reason: `not configured in condash.json` });
      continue;
    }
    if (lookup.pinnedBranch) {
      result.blocked.push({
        repo: name,
        reason: `pinned to '${lookup.pinnedBranch}' (skipped per pinned_branch:)`,
      });
      continue;
    }
    const target = join(worktreesRoot, branchDir, name);
    if (await pathExists(target)) {
      // The directory key flattens slashes (`foo/bar` and `foo-bar` collide),
      // and a leftover dir may not be a worktree at all. Classify honestly
      // instead of reporting every existing dir as "already present".
      const entries = await listWorktreeEntries(lookup.cwd);
      const registered = entries ? await findWorktreeEntry(entries, target) : null;
      if (!registered) {
        result.blocked.push({
          repo: name,
          reason: `directory ${target} exists but is not a registered worktree of ${lookup.cwd}`,
        });
      } else if (registered.branch !== branch) {
        result.blocked.push({
          repo: name,
          reason: `directory ${target} holds a worktree on branch '${registered.branch ?? '(detached)'}', not '${branch}' (flattened-path collision)`,
        });
      } else {
        result.alreadyPresent.push({ repo: name, path: target });
        // Backfill declared env files the worktree is missing (#450).
        // They're gitignored by definition, so a worktree acquired them at
        // creation or never: one made by a raw `git worktree add`, or made
        // before `env:` was declared, or set up once with --no-env, could
        // not be repaired — re-running setup stopped here and copied
        // nothing. Non-clobbering, unlike the creation path: a worktree's
        // env file is often deliberately divergent (different ports so two
        // branches can run side by side), and mirroring the primary over it
        // would destroy that silently. `install:` deliberately does NOT run
        // here — an unrequested `npm ci` on every re-run is a far larger
        // behavioural change than this repair needs.
        const missing = declaredEnvFiles(lookup, options);
        if (missing.length > 0) {
          const copied = await copyDeclaredFiles(lookup.cwd, target, missing, {
            overwrite: false,
          });
          if (copied.length > 0) result.envCopied.push({ repo: name, files: copied });
        }
      }
      continue;
    }
    const primaryBranch = await currentBranch(lookup.cwd);
    if (primaryBranch === branch) {
      result.blocked.push({
        repo: name,
        reason: `primary checkout at ${lookup.cwd} is currently on '${branch}' — switch it first`,
      });
      continue;
    }
    const branchOk = await branchExists(lookup.cwd, branch);
    let startRef: string | undefined;
    if (!branchOk) {
      if (base) {
        // New branch + base specified: the base must exist as a ref in this
        // repo. Fail loudly rather than fall back to the repo default — that's
        // exactly the silent-wrong-base behaviour issue #81 is about.
        if (!(await refExists(lookup.cwd, base))) {
          result.blocked.push({
            repo: name,
            reason: `base ref '${base}' not found in ${lookup.cwd} — run \`git fetch\` or create it locally first`,
          });
          continue;
        }
        startRef = base;
      } else {
        // No base resolved: branch from the repo's default-branch tip, not
        // whatever the primary checkout happens to have checked out (HEAD
        // could be a stale feature branch).
        startRef = await defaultBranchTip(lookup.cwd);
      }
      if (startRef) {
        // Stale-base check: when the start ref has an upstream, measure how
        // far it trails the (already-fetched) remote-tracking ref. We never
        // fetch here — the warning tells the user to.
        const behind = await behindUpstream(lookup.cwd, startRef);
        if (behind) result.baseBehind.push({ repo: name, ref: startRef, ...behind });
      }
    }
    try {
      const args = ['worktree', 'add'];
      if (!branchOk) args.push('-b', branch);
      args.push(target);
      if (branchOk) args.push(branch);
      else if (startRef) args.push(startRef);
      await exec('git', args, { cwd: lookup.cwd });
      result.created.push({ repo: name, path: target });
    } catch (err) {
      result.blocked.push({
        repo: name,
        reason: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    // Copy declared env files into the freshly created worktree. Overwriting
    // is kept here (unlike the backfill above): the worktree was created a
    // moment ago, so anything at the destination came out of the git
    // checkout rather than from a user, and mirroring the primary is exactly
    // what the `env:` declaration asks for.
    const filesToCopy = declaredEnvFiles(lookup, options);
    if (filesToCopy.length > 0) {
      const copied = await copyDeclaredFiles(lookup.cwd, target, filesToCopy, { overwrite: true });
      if (copied.length > 0) result.envCopied.push({ repo: name, files: copied });
    }
    // Per-repo `install:` runs unconditionally now (#87) — the presence of
    // the field is the user already asking for it. --no-install skips.
    if (lookup.install && !options.skipInstall) {
      const install = await runInstall(target, lookup.install);
      result.installRan.push({
        repo: name,
        command: lookup.install,
        ok: install.ok,
        ...(install.stderrTail ? { stderrTail: install.stderrTail } : {}),
      });
    }
  }

  return result;
}

/**
 * The repo's default-branch tip, used as the start ref for a new branch when
 * no `**Base**` / `--base` resolved. Resolution order: `origin/HEAD` (what
 * the remote calls its default branch), local `main`, local `master`,
 * undefined (git then branches from the primary checkout's HEAD).
 */
async function defaultBranchTip(repoCwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
      cwd: repoCwd,
    });
    const full = stdout.trim();
    if (full.startsWith('refs/remotes/')) return full.slice('refs/remotes/'.length);
  } catch {
    // No origin/HEAD — fall through to the local conventions.
  }
  for (const candidate of ['main', 'master']) {
    if (await refExists(repoCwd, `refs/heads/${candidate}`)) return candidate;
  }
  return undefined;
}

/**
 * How far `ref` trails its upstream, measured against the already-fetched
 * remote-tracking ref (`git rev-list --count <ref>..<ref>@{u}`). Returns null
 * when the ref has no upstream (e.g. it is itself a remote-tracking ref),
 * the lookup fails, or the ref is up to date.
 */
async function behindUpstream(
  repoCwd: string,
  ref: string,
): Promise<{ upstream: string; behind: number } | null> {
  try {
    const { stdout: upstreamOut } = await exec(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${ref}@{u}`],
      { cwd: repoCwd },
    );
    const upstream = upstreamOut.trim();
    if (!upstream || upstream === `${ref}@{u}`) return null;
    const { stdout: countOut } = await exec('git', ['rev-list', '--count', `${ref}..${upstream}`], {
      cwd: repoCwd,
    });
    const behind = Number.parseInt(countOut.trim(), 10);
    return Number.isFinite(behind) && behind > 0 ? { upstream, behind } : null;
  } catch {
    return null;
  }
}

/**
 * Pick the base ref. Explicit `--base` wins. Otherwise collect every distinct
 * `**Base**` value across declaring items: 0 → null (current behaviour), 1 →
 * use it, ≥2 → throw with the disagreeing items so the user can reconcile.
 * Exported for unit tests.
 */
export function resolveBase(
  branch: string,
  explicit: string | undefined,
  items: { slug: string; base: string | null }[],
): string | undefined {
  if (explicit) return explicit;
  const byBase = new Map<string, string[]>();
  for (const item of items) {
    if (!item.base) continue;
    const list = byBase.get(item.base) ?? [];
    list.push(item.slug);
    byBase.set(item.base, list);
  }
  if (byBase.size === 0) return undefined;
  if (byBase.size === 1) return [...byBase.keys()][0];
  const summary = [...byBase.entries()]
    .map(([base, slugs]) => `${base} (${slugs.join(', ')})`)
    .join('; ');
  throw new Error(
    `Items declaring branch '${branch}' disagree on **Base**: ${summary}. ` +
      `Reconcile the headers or pass --base explicitly.`,
  );
}

/**
 * The files to copy from the primary checkout for one repo. Per-repo
 * `env: [...]` is the canonical source and applies unconditionally so a
 * forgotten flag no longer leaves a Vite SPA reading `import.meta.env.VITE_*`
 * as undefined (#82, #87); `--no-env` skips it. Repos without `env:` declared
 * can still opt into the legacy `.env` / `.env.local` blanket copy via
 * `--copy-env`.
 */
function declaredEnvFiles(lookup: RepoLookupExtended, options: SetupOptions): readonly string[] {
  if (options.skipEnv) return [];
  return lookup.env ?? (options.copyEnv ? ['.env', '.env.local'] : []);
}

/**
 * Copy each declared file from the primary checkout into the worktree.
 * Best-effort: missing files are silently skipped (typical: `.env.local`
 * not present), but anything declared with a path-traversal segment is
 * rejected outright. With `overwrite: false` a file the worktree already has
 * is left untouched, so a backfill never destroys a deliberately divergent
 * copy. Returns the list of files actually copied (each as the relative path
 * declared in `env:`).
 */
async function copyDeclaredFiles(
  source: string,
  target: string,
  files: readonly string[],
  options: { overwrite: boolean },
): Promise<string[]> {
  const out: string[] = [];
  for (const rel of files) {
    if (!isSafeRelativePath(rel)) continue;
    const src = join(source, rel);
    if (!(await pathExists(src))) continue;
    const dest = join(target, rel);
    if (!options.overwrite && (await pathExists(dest))) continue;
    try {
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      out.push(rel);
    } catch {
      // best-effort
    }
  }
  return out;
}

/**
 * Reject anything that could escape the worktree on copy: absolute paths,
 * `..` segments, NUL. Forward and backslash separators are both checked
 * because a Windows config could carry either. Exported for unit tests.
 */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return false; // Windows drive prefix
  const segments = rel.split(/[\\/]/);
  return !segments.some((s) => s === '..' || s === '.');
}

/**
 * Run the per-repo `install:` command. On failure, captures the last few
 * stderr lines (falling back to the error message) so the FAILED row in the
 * result is diagnosable instead of silent.
 */
async function runInstall(
  cwd: string,
  command: string,
): Promise<{ ok: boolean; stderrTail?: string }> {
  try {
    await exec(process.platform === 'win32' ? 'cmd.exe' : 'sh', shellArgs(command), {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      // npm install & friends legitimately run long — disable the exec
      // module's 60 s default timeout for this call.
      timeout: 0,
    });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const text =
      typeof stderr === 'string' && stderr.trim().length > 0
        ? stderr
        : err instanceof Error
          ? err.message
          : String(err);
    const tail = text.trim().split('\n').slice(-5).join('\n');
    return { ok: false, stderrTail: tail };
  }
}

function shellArgs(command: string): string[] {
  if (process.platform === 'win32') return ['/d', '/s', '/c', command];
  return ['-lc', command];
}
