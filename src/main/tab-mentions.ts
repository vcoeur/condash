/**
 * Suggest a project↔tab link from what a terminal tab *says*.
 *
 * condash already captures every tab's recent output in memory (`tabRecentText`
 * in `terminals.ts` — a cooperating agent's role-tagged sidecar transcript when
 * there is one, else the cleaned raw pty buffer). An agent working a conception
 * project prints that project's slug and README path constantly, because it has
 * to read and write `projects/YYYY-MM/<slug>/README.md`. So the link can be
 * derived from the text without the user linking anything — and, unlike the
 * tab's cwd, this signal is present even when nobody ever `cd`s into a worktree.
 *
 * The verdict is only ever a **suggestion**. Nothing here writes a relation: the
 * renderer surfaces the suggested project on the card's Link button, and the
 * user's click writes an ordinary manual link through the existing
 * `linkProject`. That keeps this module free of the persisted link store's
 * lifecycle entirely — no inferred relations, no revoke pass, no tombstones —
 * and makes a wrong guess cost nothing, which matters because the evidence here
 * is probabilistic in a way cwd never was.
 *
 * The scan is **stateless**: each pass scores the current output window from
 * scratch rather than accumulating with a decay. Old text scrolls out of the
 * window on its own, so recency is free, there is no cursor or accumulator to
 * get wrong, and a repeated scan of an unchanged tab is idempotent.
 *
 * The matched text never leaves this module — callers get a slug and nothing
 * else. The renderer displays the tab's output already (it is the terminal
 * emulator), but it has no business receiving a *snippet the machine picked out*
 * as interesting: that is how the dashboard summarizer's redaction problem
 * started, and not surfacing the match keeps this feature outside it.
 */

import type { Project } from '../shared/types';

/** One needle that identifies a project, with the confidence a hit carries. */
interface Needle {
  /** Lowercased text to search for. */
  text: string;
  /** Dated slug of the project this needle identifies. */
  slug: string;
  /** Score contributed per occurrence — see {@link WEIGHTS}. */
  weight: number;
}

/**
 * Per-needle confidence. A dated slug is effectively unique to one project; a
 * short slug is distinctive but can appear as ordinary prose; a bare branch name
 * is the weakest (branches outlive their project and get typed by hand).
 */
const WEIGHTS = { datedSlug: 3, shortSlug: 2, branch: 1 } as const;

/** Chars of recent output scored per pass. Large enough to hold an agent's last
 *  few turns, small enough that the whole scan stays well inside one tick. */
export const SCAN_WINDOW_CHARS = 8000;

/** Distinct projects in one window above which the window is treated as a
 *  listing (a `condash projects list`, an index regeneration, a tree-wide grep)
 *  and scored as evidence for nothing. Without this, one listing would suggest
 *  whichever project happened to sort first. */
export const BURST_DISTINCT_SLUGS = 4;

/** Minimum score for a suggestion. Three sightings of a short slug, or one
 *  dated slug, is the floor — below that a single incidental mention would
 *  suggest a project the tab merely referred to in passing. */
export const MIN_SCORE = 3;

/** How far the leader must be ahead of the runner-up. A tab that talks about
 *  two projects roughly equally has not told us which one it is *for*, and
 *  suggesting either would be a coin flip presented as a finding. */
export const DOMINANCE_RATIO = 2;

/** The date-prefix every conception item folder carries (`YYYY-MM-DD-`). */
const DATED_SLUG_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/**
 * The part of a dated slug after its `YYYY-MM-DD-` prefix — what people and
 * agents actually type. Empty when the slug carries no date prefix.
 */
function shortSlugOf(slug: string): string {
  return DATED_SLUG_PREFIX.test(slug) ? slug.replace(DATED_SLUG_PREFIX, '') : '';
}

/**
 * Build the needle set for one scan.
 *
 * Only **non-`done`** projects are candidates. That single rule is the bulk of
 * the false-positive defence: this tree carries ~1000 project directories but
 * only ~30 that are not done, and a listing or a grep over the tree prints
 * mostly done slugs. It also keeps the scan cheap enough to ride an existing
 * timer.
 *
 * Needles are ordered longest-first so {@link scoreWindow} consumes the dated
 * slug before the short slug nested inside it and counts each sighting once.
 *
 * @param projects Every project in the tree; `done` ones are filtered out here.
 * @param longLivedBranches Branch names that identify no single project
 *   (`main`, `develop`, …) — their branch needle is dropped.
 * @returns Needles across all candidate projects, longest text first.
 */
export function buildNeedles(
  projects: readonly Project[],
  longLivedBranches: readonly string[] = [],
): Needle[] {
  const longLived = new Set(longLivedBranches.map((b) => b.toLowerCase()));
  const out: Needle[] = [];
  for (const project of projects) {
    if (project.status === 'done') continue;
    const slug = project.slug.toLowerCase();
    if (!slug) continue;
    // Per-project dedupe: a project whose branch equals its short slug — the
    // common case, since `worktree setup` names the branch after the work —
    // would otherwise contribute the same text twice and double its own score.
    const seen = new Set<string>();
    const add = (text: string, weight: number): void => {
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push({ text, slug: project.slug, weight });
    };
    add(slug, WEIGHTS.datedSlug);
    add(shortSlugOf(slug), WEIGHTS.shortSlug);
    const branch = project.branch?.toLowerCase() ?? '';
    if (branch && !longLived.has(branch)) add(branch, WEIGHTS.branch);
  }
  // Longest first so a nested needle cannot claim text its container already
  // consumed. Ties broken by text for a deterministic order (tests, and so two
  // equal-length needles always resolve the same way).
  out.sort((a, b) => b.text.length - a.text.length || a.text.localeCompare(b.text));
  return out;
}

/**
 * Score one window of terminal output.
 *
 * Occurrences are counted longest-needle-first over a consumed-character mask,
 * so a match overlapping text a longer needle already claimed is skipped —
 * `2026-08-21-foo` scores as one dated-slug sighting rather than also as a `foo`
 * short-slug sighting. The mask is one byte per character and never reallocates;
 * an earlier version blanked the matched span out of a working copy of the
 * window, which rebuilt the whole string once per match.
 *
 * @param text Recent output; case-insensitive, so it is lowercased here.
 * @param needles From {@link buildNeedles} — must be longest-first.
 * @returns Score per project slug; projects with no sighting are absent. Empty
 *   when the window mentions more than {@link BURST_DISTINCT_SLUGS} projects,
 *   which reads as a listing rather than as work on any one of them.
 */
export function scoreWindow(text: string, needles: readonly Needle[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (!text) return scores;
  const haystack = text.toLowerCase();
  const consumed = new Uint8Array(haystack.length);
  for (const needle of needles) {
    const width = needle.text.length;
    let from = 0;
    let hits = 0;
    for (;;) {
      const at = haystack.indexOf(needle.text, from);
      if (at === -1) break;
      from = at + width;
      let overlaps = false;
      for (let i = at; i < at + width; i++) {
        if (consumed[i]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      consumed.fill(1, at, at + width);
      hits += 1;
    }
    if (hits > 0) scores.set(needle.slug, (scores.get(needle.slug) ?? 0) + hits * needle.weight);
  }
  // Burst suppression, applied after counting so it sees the true breadth of the
  // window: a listing mentions many projects once each, which is the shape this
  // rejects. A tab genuinely working two projects stays under the threshold and
  // is then resolved (or not) by the dominance rule in `pickSuggestion`.
  if (scores.size > BURST_DISTINCT_SLUGS) scores.clear();
  return scores;
}

/**
 * The project a scored window suggests, if any.
 *
 * Requires both a floor ({@link MIN_SCORE}) and a clear lead over the runner-up
 * ({@link DOMINANCE_RATIO}) — an ambiguous window suggests nothing rather than
 * guessing, because the whole value of a suggestion is that it is usually right.
 *
 * @param scores From {@link scoreWindow}.
 * @returns The suggested project slug, or undefined when nothing leads clearly.
 */
export function pickSuggestion(scores: ReadonlyMap<string, number>): string | undefined {
  let best: { slug: string; score: number } | undefined;
  let runnerUp = 0;
  for (const [slug, score] of scores) {
    if (!best || score > best.score) {
      if (best) runnerUp = best.score;
      best = { slug, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best || best.score < MIN_SCORE) return undefined;
  if (runnerUp > 0 && best.score < runnerUp * DOMINANCE_RATIO) return undefined;
  return best.slug;
}

/**
 * The project one tab's recent output suggests — {@link scoreWindow} then
 * {@link pickSuggestion}.
 *
 * @param text Recent output for the tab.
 * @param needles From {@link buildNeedles}.
 * @returns The suggested project slug, or undefined.
 */
export function suggestProjectForText(
  text: string,
  needles: readonly Needle[],
): string | undefined {
  return pickSuggestion(scoreWindow(text, needles));
}
