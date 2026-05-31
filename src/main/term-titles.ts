/**
 * `.condash/term-titles.json` — the watched product of capability 3.
 *
 * condash does **not** know how the file is produced: a scheduled or adopted
 * task writes it (sparse, atomic tmp+rename); condash watches it and, on
 * change, validates + clamps it into a list of `{sid, title}` auto-titles that
 * the renderer sparse-merges onto its tabs. The task owns all title *state*
 * (it reads back its own prior file); condash holds none.
 *
 * This module is the single parser/validator. It is pure + `fs`-free below
 * `readTermTitles` (split out so the watcher and the unit tests can share the
 * validation without a real file). Malformed / partial input yields `[]` — the
 * caller does nothing and current titles are left untouched.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { TermAutoTitle } from '../shared/types';
import { condashDir } from './condash-dir';

/** Watched filename inside `.condash/`. */
export const TERM_TITLES_FILENAME = 'term-titles.json';

/** Absolute path to `<conception>/.condash/term-titles.json`. */
export function termTitlesPath(conception: string): string {
  return join(condashDir(conception), TERM_TITLES_FILENAME);
}

/** Max rendered length of an applied title. Longer titles are truncated with
 *  an ellipsis — the one-sentence summary (the task's own memory) carries the
 *  detail; the tab strip only has room for a few words. */
export const TITLE_MAX_LEN = 48;

/** The on-disk shape. `summary` is the *task's* memory — read back by the task
 *  on its next cycle — and `lineCount` is a tolerated legacy field (the task
 *  tracked its own staleness before condash gained the per-tab `{UPDATED_TABS}`
 *  gate). Both are accepted here so the file validates, but ignored by condash's
 *  apply path, which only needs `title`. */
const titleEntrySchema = z
  .object({
    sid: z.string().min(1),
    title: z.string(),
    summary: z.string().optional(),
    lineCount: z.number().optional(),
  })
  .passthrough();

const termTitlesSchema = z.object({
  titles: z.array(titleEntrySchema),
});

/** Collapse internal whitespace and clamp to `TITLE_MAX_LEN`. */
function clampTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_MAX_LEN) return collapsed;
  return collapsed.slice(0, TITLE_MAX_LEN - 1).trimEnd() + '…';
}

/**
 * Validate a raw JSON string into the list of `{sid, title}` auto-titles.
 * Returns `[]` on any parse / shape error (malformed, partial, wrong type) so
 * a half-written or corrupt file is a no-op rather than a crash. Entries with
 * an empty title after clamping are dropped (an empty auto-title would just
 * fall through to the cwd basename anyway, and we never want to *blank* a tab).
 */
export function validateTermTitles(raw: string): TermAutoTitle[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = termTitlesSchema.safeParse(parsed);
  if (!result.success) return [];
  const out: TermAutoTitle[] = [];
  const seen = new Set<string>();
  for (const entry of result.data.titles) {
    if (seen.has(entry.sid)) continue;
    const title = clampTitle(entry.title);
    if (title.length === 0) continue;
    seen.add(entry.sid);
    out.push({ sid: entry.sid, title });
  }
  return out;
}

/** Read + validate the active conception's `term-titles.json`. Missing /
 *  unreadable file → `[]`. */
export async function readTermTitles(conception: string): Promise<TermAutoTitle[]> {
  let raw: string;
  try {
    raw = await fs.readFile(termTitlesPath(conception), 'utf8');
  } catch {
    return [];
  }
  return validateTermTitles(raw);
}
