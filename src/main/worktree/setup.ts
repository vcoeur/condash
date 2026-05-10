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
  currentBranch,
  defaultWorktreesPath,
  findItemsDeclaringBranch,
  readConfig,
  refExists,
  repoLookupMap,
  resolveTargetRepos,
  validateBranchName,
} from './shared';

export interface SetupOptions {
  /** Optional explicit repo allow-list (overrides Apps-derivation). */
  repos?: string[];
  /** Legacy opportunistic copy of `.env` / `.env.local` from the primary
   *  into the new worktree. Repos with `env:` declared in
   *  `condash.json` always have those files copied; this flag only
   *  affects repos *without* an `env:` declaration. */
  copyEnv?: boolean;
  /** Skip env-file copy for repos that declare `env:` in condash.json.
   *  Per-repo `env:` is otherwise applied unconditionally. Closes #87. */
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
  /** Repos we skipped because the worktree already existed. */
  alreadyPresent: { repo: string; path: string }[];
  /** Repos we couldn't set up — primary checkout already on the branch, etc. */
  blocked: { repo: string; reason: string }[];
  /** `.env` files copied (relative to the worktree root). */
  envCopied: { repo: string; files: string[] }[];
  /** Install commands run. */
  installRan: { repo: string; command: string; ok: boolean }[];
  /** Base ref new branches were created from (null when no base was resolved
   *  and the repo's default tip was used). */
  base: string | null;
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
  };

  await fs.mkdir(join(worktreesRoot, branch), { recursive: true });

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
    const target = join(worktreesRoot, branch, name);
    if (await pathExists(target)) {
      result.alreadyPresent.push({ repo: name, path: target });
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
    if (!branchOk && base) {
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
    }
    try {
      const args = ['worktree', 'add'];
      if (!branchOk) args.push('-b', branch);
      args.push(target);
      if (branchOk) args.push(branch);
      else if (base) args.push(base);
      await exec('git', args, { cwd: lookup.cwd });
      result.created.push({ repo: name, path: target });
    } catch (err) {
      result.blocked.push({
        repo: name,
        reason: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    // Copy declared env files. Per-repo `env: [...]` is the canonical source
    // and applied unconditionally so a forgotten flag no longer leaves a Vite
    // SPA reading `import.meta.env.VITE_*` as undefined (#82, #87). Pass
    // --no-env to skip. Repos without `env:` declared can still opt into the
    // legacy `.env` / `.env.local` blanket copy via --copy-env.
    const filesToCopy = options.skipEnv
      ? []
      : (lookup.env ?? (options.copyEnv ? ['.env', '.env.local'] : []));
    if (filesToCopy.length > 0) {
      const copied = await copyDeclaredFiles(lookup.cwd, target, filesToCopy);
      if (copied.length > 0) result.envCopied.push({ repo: name, files: copied });
    }
    // Per-repo `install:` runs unconditionally now (#87) — the presence of
    // the field is the user already asking for it. --no-install skips.
    if (lookup.install && !options.skipInstall) {
      const ok = await runInstall(target, lookup.install);
      result.installRan.push({ repo: name, command: lookup.install, ok });
    }
  }

  return result;
}

/**
 * Pick the base ref. Explicit `--base` wins. Otherwise collect every distinct
 * `**Base**` value across declaring items: 0 → null (current behaviour), 1 →
 * use it, ≥2 → throw with the disagreeing items so the user can reconcile.
 */
function resolveBase(
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
 * Copy each declared file from the primary checkout to the new worktree.
 * Best-effort: missing files are silently skipped (typical: `.env.local`
 * not present), but anything declared with a path-traversal segment is
 * rejected outright. Returns the list of files actually copied (each as
 * the relative path declared in `env:`).
 */
async function copyDeclaredFiles(
  source: string,
  target: string,
  files: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const rel of files) {
    if (!isSafeRelativePath(rel)) continue;
    const src = join(source, rel);
    if (!(await pathExists(src))) continue;
    try {
      const dest = join(target, rel);
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
 * because a Windows config could carry either.
 */
function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return false; // Windows drive prefix
  const segments = rel.split(/[\\/]/);
  return !segments.some((s) => s === '..' || s === '.');
}

async function runInstall(cwd: string, command: string): Promise<boolean> {
  try {
    await exec(process.platform === 'win32' ? 'cmd.exe' : 'sh', shellArgs(command), {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function shellArgs(command: string): string[] {
  if (process.platform === 'win32') return ['/d', '/s', '/c', command];
  return ['-lc', command];
}
