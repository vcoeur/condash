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

import type { PullRequestInfo } from '../shared/types';
import { exec } from './exec';

/** How long a resolved lookup (a PR or a "none") is reused before `gh` is
 *  asked again. Long enough that reopening a card's menu is instant, short
 *  enough that a freshly-opened PR appears without a manual refresh. */
const CACHE_TTL_MS = 60_000;

/** UI-triggered network lookup — cap it well below the house 60 s default so
 *  a wedged `gh` resolves to "no PR row" promptly instead of leaving the item
 *  pending for a minute. */
const LOOKUP_TIMEOUT_MS = 15_000;

interface CacheEntry {
  at: number;
  value: PullRequestInfo | null;
}
const cache = new Map<string, CacheEntry>();

const cacheKey = (path: string, branch: string): string => JSON.stringify([path, branch]);

/** Shape of one element of `gh pr list --json url,number,title,isDraft`
 *  output. Fields are `unknown` because the array is parsed from untrusted
 *  stdout and validated in `parseGhPrList`. */
interface GhPrRow {
  number?: unknown;
  url?: unknown;
  title?: unknown;
  isDraft?: unknown;
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
  const first = parsed[0] as GhPrRow;
  if (typeof first.number !== 'number') return null;
  if (typeof first.url !== 'string' || first.url.length === 0) return null;
  return {
    number: first.number,
    url: first.url,
    title: typeof first.title === 'string' ? first.title : '',
    isDraft: first.isDraft === true,
  };
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
