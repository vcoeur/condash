// "Open PR" lookup behind the Code-pane per-branch actions menu.
//
// Resolves the open GitHub pull request whose head is a worktree's branch by
// shelling out to `gh pr list --head <branch> --state open` in the worktree
// directory (gh resolves owner/repo from the checkout's remotes). Returns the
// most-recent match, or null when there's no open PR — or when the lookup
// can't run at all (gh missing / unauthenticated, no GitHub remote, not a
// repo). The actions menu fires this on every open, so a failure is a quiet
// "no PR row", never a thrown error or toast.
//
// The JSON parse is split into a pure `parseGhPrList` helper so the field
// mapping is unit-tested without a live gh (mirrors the classify* split in
// pull-branch.ts). A short TTL cache keyed by (path, branch) collapses the
// repeated lookups a user makes reopening the same card's menu.
//
// `listOpenPullRequests` is the batch variant behind the Projects-pane card
// badges: one `gh pr list` per repo returns every open PR (with its head
// branch), so a pane full of project cards costs one call per repo instead of
// one per card. It's cached by repo cwd.

import type { OpenPullRequest, PullRequestInfo } from '../shared/types';
import { exec } from './exec';

/** How long a resolved lookup (a PR or a "none") is reused before `gh` is
 *  asked again. Long enough that reopening a card's menu is instant, short
 *  enough that a freshly-opened PR appears without a manual refresh. */
const CACHE_TTL_MS = 60_000;

/** UI-triggered network lookup — cap it well below the house 60 s default so
 *  a wedged `gh` resolves to "no PR row" promptly instead of leaving the item
 *  pending for a minute. */
const LOOKUP_TIMEOUT_MS = 15_000;

/** Upper bound on open PRs read per repo for the Projects-pane batch. Well
 *  above any realistic open-PR count for the repos condash tracks; a repo
 *  with more simply won't badge the overflow. */
const LIST_LIMIT = 100;

interface CacheEntry {
  at: number;
  value: PullRequestInfo | null;
}
const cache = new Map<string, CacheEntry>();

interface ListCacheEntry {
  at: number;
  value: OpenPullRequest[];
}
const listCache = new Map<string, ListCacheEntry>();

const cacheKey = (path: string, branch: string): string => JSON.stringify([path, branch]);

/** Shape of one element of `gh pr list --json …` output. Fields are `unknown`
 *  because the array is parsed from untrusted stdout and validated in the
 *  parsers below. `headRefName` is only requested by the batch list. */
interface GhPrRow {
  number?: unknown;
  url?: unknown;
  title?: unknown;
  isDraft?: unknown;
  headRefName?: unknown;
}

/** Map one validated `gh pr list` row to a `PullRequestInfo`, or null when a
 *  required field is missing / wrong-typed. Shared by both parsers. */
function toPullRequestInfo(row: GhPrRow): PullRequestInfo | null {
  if (typeof row.number !== 'number') return null;
  if (typeof row.url !== 'string' || row.url.length === 0) return null;
  return {
    number: row.number,
    url: row.url,
    title: typeof row.title === 'string' ? row.title : '',
    isDraft: row.isDraft === true,
  };
}

/** Parse `gh pr list --json …` stdout into the first well-formed PR, or null
 *  when the array is empty, unparseable, or missing the fields we need. Pure;
 *  exported for tests. */
export function parseGhPrList(stdout: string): PullRequestInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return toPullRequestInfo(parsed[0] as GhPrRow);
}

/** Parse `gh pr list --json …,headRefName` stdout into every well-formed open
 *  PR, each carrying its head branch. Rows missing a required field or a
 *  string `headRefName` are dropped; an empty / unparseable payload yields an
 *  empty array. Pure; exported for tests. */
export function parseOpenPrList(stdout: string): OpenPullRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: OpenPullRequest[] = [];
  for (const raw of parsed) {
    const row = raw as GhPrRow;
    const info = toPullRequestInfo(row);
    if (!info) continue;
    if (typeof row.headRefName !== 'string' || row.headRefName.length === 0) continue;
    out.push({ ...info, headRefName: row.headRefName });
  }
  return out;
}

/**
 * Resolve the open PR whose head is `branch`, running `gh` in `path`. Returns
 * the PR, or null when there is none or the lookup can't run (unauthenticated
 * gh, no GitHub remote, gh absent). Never throws — the caller renders "no PR
 * row" for a null, and this fires on every menu-open, so a transient failure
 * must not surface as an error.
 *
 * @param path   Absolute path to the worktree working directory.
 * @param branch Branch name to match as the PR head ref.
 * @returns The open PR for the branch, or null.
 */
export async function lookupPullRequest(
  path: string,
  branch: string,
): Promise<PullRequestInfo | null> {
  const key = cacheKey(path, branch);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: PullRequestInfo | null = null;
  try {
    const { stdout } = await exec(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'url,number,title,isDraft',
        '--limit',
        '1',
      ],
      { cwd: path, timeout: LOOKUP_TIMEOUT_MS },
    );
    value = parseGhPrList(stdout);
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * List every open PR in the repo checked out at `cwd`, each with its head
 * branch — the batch behind the Projects-pane card badges. One call covers
 * every card for that repo. Returns an empty array when the repo has no open
 * PRs or the lookup can't run (unauthenticated gh, no GitHub remote, gh
 * absent). Never throws; cached by `cwd` for `CACHE_TTL_MS`.
 *
 * @param cwd Absolute path to a checkout of the repo (any worktree of it).
 * @returns The repo's open PRs (possibly empty).
 */
export async function listOpenPullRequests(cwd: string): Promise<OpenPullRequest[]> {
  const hit = listCache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: OpenPullRequest[] = [];
  try {
    const { stdout } = await exec(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'url,number,title,isDraft,headRefName',
        '--limit',
        String(LIST_LIMIT),
      ],
      { cwd, timeout: LOOKUP_TIMEOUT_MS },
    );
    value = parseOpenPrList(stdout);
  } catch {
    value = [];
  }
  listCache.set(cwd, { at: Date.now(), value });
  return value;
}
