/**
 * Pure close-milestone synthesis for `condash sync`.
 *
 * Closing an item is write-files-only for agents: the close ritual flips the
 * status and appends a `- YYYY-MM-DD — Closed. <summary>.` timeline entry,
 * and the sweeper turns the sweep that introduces that entry into a
 * `Close <item>. Outcome: …` milestone commit. Detection is a pure
 * HEAD-vs-worktree comparison of README text — no disk access — so it
 * unit-tests without a fixture repo.
 */

/** `- YYYY-MM-DD — Closed. <summary>.` or bare `- YYYY-MM-DD — Closed.` —
 *  the exact shape `transitionStatus` writes on a done-edge (see the
 *  canonical `CLOSED_LINE` in `shared/header.ts`; this variant additionally
 *  captures the summary). */
const CLOSED_ENTRY = /^-\s*\d{4}-\d{2}-\d{2}\s*—\s*Closed\.\s*(.*)$/;

/**
 * Extract the `Closed.` timeline entries from a README's markdown text.
 *
 * @param markdown full README text (pass `''` for a file absent from HEAD)
 * @returns each entry's summary text, in file order — `''` for the bare
 *          `- YYYY-MM-DD — Closed.` form
 */
export function extractClosedEntries(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(CLOSED_ENTRY);
    if (match) out.push(match[1].trim());
  }
  return out;
}

/**
 * Compose the milestone subject for an item commit that introduces a close.
 *
 * A worktree README carrying more `Closed.` entries than its HEAD version
 * means this sweep commits the close, so the item deserves a real history
 * line instead of `<item>: sync`. The last entry wins (a reopen-then-close
 * appends a second one), and its trailing period is stripped so the subject
 * ends with exactly one.
 *
 * @param item item dir name, e.g. `2026-07-10-foo`
 * @param headEntries `Closed.` summaries in the HEAD version of the README
 * @param worktreeEntries `Closed.` summaries in the worktree version
 * @returns `Close <item>. Outcome: <summary>.` — `Close <item>.` for a bare
 *          entry — or `null` when the sweep introduces no close
 */
export function closeMilestoneSubject(
  item: string,
  headEntries: readonly string[],
  worktreeEntries: readonly string[],
): string | null {
  if (worktreeEntries.length <= headEntries.length) return null;
  const summary = worktreeEntries[worktreeEntries.length - 1].replace(/\.$/, '');
  return summary === '' ? `Close ${item}.` : `Close ${item}. Outcome: ${summary}.`;
}
