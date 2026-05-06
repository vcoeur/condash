/**
 * Pure helpers for building project folder slugs.
 *
 * `slugify` derives a folder-name tail (the part after the YYYY-MM-DD date
 * prefix) from a free-text title. The output is guaranteed to satisfy the
 * tail regex used by the CLI's create verb (`^[a-z0-9-]+$`) — empty when the
 * title contains no usable characters.
 */

const SLUG_MAX_LEN = 60;
const COMBINING_MARKS = /[̀-ͯ]/g;
const NON_ALNUM = /[^a-z0-9]+/g;

/**
 * Normalise a title into a folder-tail slug.
 *
 * Rules: NFKD-strip diacritics, lowercase, replace any non-`[a-z0-9]` run with
 * a single `-`, trim leading/trailing `-`, cap at SLUG_MAX_LEN characters.
 * The result is `[a-z0-9-]*` and never starts or ends with `-`.
 */
export function slugify(title: string): string {
  if (typeof title !== 'string') return '';
  const folded = title.normalize('NFKD').replace(COMBINING_MARKS, '');
  const lowered = folded.toLowerCase();
  const dashed = lowered.replace(NON_ALNUM, '-');
  let trimmed = dashed.replace(/^-+/, '').replace(/-+$/, '');
  if (trimmed.length > SLUG_MAX_LEN) {
    trimmed = trimmed.slice(0, SLUG_MAX_LEN).replace(/-+$/, '');
  }
  return trimmed;
}

/** True when a value already matches the on-disk slug-tail regex.
 *
 *  Tightened from the original `[a-z0-9-]+` which accepted leading/trailing
 *  hyphens, doubled hyphens, and 200-character runaway strings. The
 *  constructor for new project folders (and the rename guard) needs every
 *  produced tail to round-trip cleanly through `slugify`, which it can't
 *  if the tail starts with `-`, ends with `-`, or contains `--`.
 */
export function isValidSlugTail(value: string): boolean {
  if (value.length === 0 || value.length > SLUG_MAX_LEN) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
