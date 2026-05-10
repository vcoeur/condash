import type { OpenWithSlotKey, RepoEntry, Worktree } from '@shared/types';

export type RepoStatus = 'missing' | 'unknown' | 'clean' | 'dirty';

export const LAUNCHER_SLOTS: readonly OpenWithSlotKey[] = ['main_ide', 'secondary_ide', 'terminal'];

export const LAUNCHER_GLYPH: Record<OpenWithSlotKey, string> = {
  main_ide: '⌘',
  secondary_ide: '⌥',
  terminal: '▶',
};

/** Bar width (chars) for the +/- visual on each dirty row. Single-file
 *  diffs map line count → bar width 1:1 up to BAR_WIDTH; bigger diffs
 *  scale proportionally so a 200-line edit and a 2000-line edit both fill
 *  the bar but keep their `+`/`-` ratio readable. */
const BAR_WIDTH = 10;

export function buildBar(added: number, deleted: number): string {
  const total = added + deleted;
  if (total === 0) return '';
  if (total <= BAR_WIDTH) {
    return '+'.repeat(added) + '-'.repeat(deleted);
  }
  let plus = Math.round((BAR_WIDTH * added) / total);
  // Don't render an empty bar for a non-zero `added` (or vice versa) just
  // because rounding pushed it to 0. The opposite side gives up one cell.
  if (added > 0 && plus === 0) plus = 1;
  if (deleted > 0 && plus === BAR_WIDTH) plus = BAR_WIDTH - 1;
  return '+'.repeat(plus) + '-'.repeat(BAR_WIDTH - plus);
}

/** Flatten the configured repo list into one ordered card sequence, with each
 *  submodule parent immediately followed by its children. Top-level entries
 *  with no children pass through in declaration order. */
export function orderedRepos(repos: readonly RepoEntry[]): RepoEntry[] {
  const childrenByParent = new Map<string, RepoEntry[]>();
  for (const r of repos) {
    if (!r.parent) continue;
    const arr = childrenByParent.get(r.parent) ?? [];
    arr.push(r);
    childrenByParent.set(r.parent, arr);
  }
  const out: RepoEntry[] = [];
  for (const r of repos) {
    if (r.parent) continue;
    out.push(r);
    const kids = childrenByParent.get(r.name);
    if (kids) out.push(...kids);
  }
  return out;
}

/** Synthesise the primary checkout as a Worktree-shaped row when the data
 * layer didn't return any worktrees (e.g. repo missing or git failed). The
 * branch is unknown so we leave it null. */
export function ensureWorktrees(repo: RepoEntry): Worktree[] {
  if (repo.worktrees && repo.worktrees.length > 0) return repo.worktrees;
  return [
    {
      path: repo.path,
      branch: null,
      primary: true,
      dirty: repo.dirty,
    },
  ];
}

/** Sort: primary checkout first, then worktrees alphabetically. */
export function orderedWorktrees(repo: RepoEntry): Worktree[] {
  const list = ensureWorktrees(repo).slice();
  list.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return (a.branch ?? '').localeCompare(b.branch ?? '');
  });
  return list;
}
