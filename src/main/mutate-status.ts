import { promises as fs } from 'node:fs';
import type { TransitionResult } from '../shared/types';
import { KNOWN_STATUSES } from '../shared/types';
import { CLOSED_LINE } from '../shared/header';
import { isoToday } from '../shared/iso-today';
import { atomicWrite } from './atomic-write';
import { detectEol, withFileQueue } from './mutate-shared';

/**
 * Status-line transitions and `## Timeline` editing. Every status change (CLI
 * close / status set / reopen, GUI status menu) funnels through
 * `transitionStatus`, so the "did the timeline get a Closed./Reopened. line"
 * invariant lives in one place. Step-checklist editing lives in
 * `mutate-steps.ts`; the generic note/config writer in `write-config.ts`.
 */

const STATUS_LINE_RE = /^(\*\*Status\*\*\s*:\s*)(\S+)\s*$/i;
// Bare YAML mapping line within the frontmatter block. Tolerates an optional
// surrounding quote on the value so `status: "now"` and `status: 'now'`
// round-trip without quote drift. Group 1 is the leading `status: ` so we
// can rebuild the line; group 2 carries the matched quote (empty when none).
const YAML_STATUS_LINE_RE = /^(status:\s*)(["']?)([A-Za-z]+)\2\s*$/i;
const FRONTMATTER_OPEN_RE = /^---\s*$/;

export type { TransitionResult } from '../shared/types';

export interface TransitionOpts {
  /** Free-text appended to a `Closed.` timeline entry. Ignored on reopen. */
  summary?: string;
  /** Inject the date for tests. Defaults to today, ISO. */
  today?: string;
}

/**
 * Flip the **Status** header line and, on done-edges, append a timeline
 * entry. The single transition primitive: every other surface (CLI close /
 * status set / reopen, GUI status menu) goes through this function, so the
 * "did the timeline get a Closed./Reopened. line" invariant lives in one
 * place. Other transitions (e.g. now → review) only touch the header.
 *
 * Edge rules:
 *   prev != 'done', next == 'done'   → "- <today> — Closed. <summary>."
 *   prev == 'done', next != 'done'   → "- <today> — Reopened."
 *   any other transition (incl. no-op): no timeline write.
 *
 * Throws when the README has no **Status** line in its metadata block.
 */
export async function transitionStatus(
  readmePath: string,
  newStatus: string,
  opts: TransitionOpts = {},
): Promise<TransitionResult> {
  // Runtime-validate the incoming status — written verbatim into the
  // README's **Status** metadata line. Without this guard a hostile
  // renderer could inject newlines or arbitrary bytes through the IPC
  // boundary and corrupt the metadata block.
  if (!(KNOWN_STATUSES as readonly string[]).includes(newStatus)) {
    throw new Error(
      `transitionStatus: unknown status (expected one of ${KNOWN_STATUSES.join(', ')})`,
    );
  }
  return withFileQueue(readmePath, async () => {
    const raw = await fs.readFile(readmePath, 'utf8');
    const eol = detectEol(raw);
    let lines = raw.split(/\r?\n/);

    let previous: string | null = null;
    let updated = false;
    if (lines.length > 0 && FRONTMATTER_OPEN_RE.test(lines[0])) {
      // YAML frontmatter shape: walk only inside the `---` fence so a
      // body-level "status:" line (e.g. inside a code block in ## Notes)
      // can't be mistaken for the metadata field.
      for (let i = 1; i < lines.length; i++) {
        if (FRONTMATTER_OPEN_RE.test(lines[i])) break;
        const match = lines[i].match(YAML_STATUS_LINE_RE);
        if (match) {
          previous = match[3].trim().toLowerCase();
          // Preserve the original quoting convention (none / "double" /
          // 'single') so a hand-edited file isn't reformatted on every flip.
          const quote = match[2];
          lines[i] = `${match[1]}${quote}${newStatus}${quote}`;
          updated = true;
          break;
        }
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) break;
        const match = lines[i].match(STATUS_LINE_RE);
        if (match) {
          previous = match[2].trim().toLowerCase();
          lines[i] = `${match[1]}${newStatus}`;
          updated = true;
          break;
        }
      }
    }
    if (!updated) {
      throw new Error('No status line found in metadata block');
    }

    let timelineAppended: string | null = null;
    const today = opts.today ?? isoToday();
    if (previous !== 'done' && newStatus === 'done') {
      const summary = opts.summary?.trim();
      timelineAppended = summary ? `- ${today} — Closed. ${summary}.` : `- ${today} — Closed.`;
      lines = appendTimelineLines(lines, timelineAppended);
    } else if (previous === 'done' && newStatus !== 'done') {
      timelineAppended = `- ${today} — Reopened.`;
      lines = appendTimelineLines(lines, timelineAppended);
    }

    await atomicWrite(readmePath, lines.join(eol));
    return { previousStatus: previous, newStatus, timelineAppended };
  });
}

/**
 * Append a single timeline line (`- <date> — <text>`) to the `## Timeline`
 * section of a README. Returns the new lines array; does not write to disk.
 * Shared by `transitionStatus` and `appendTimelineEntry` so they use one
 * insertion algorithm.
 *
 * Insertion is bottom-of-section: the new line lands after the last existing
 * entry but before the trailing blank lines, preserving the conventional
 * blank-line gap before the next ## section. When the README has no
 * `## Timeline` section, one is appended at the end of the file.
 */
function appendTimelineLines(lines: readonly string[], line: string): string[] {
  const out = [...lines];
  let timelineHeading = -1;
  for (let i = 0; i < out.length; i++) {
    const m = out[i].match(/^##\s+(.+)$/);
    if (m && m[1].trim().toLowerCase() === 'timeline') {
      timelineHeading = i;
      break;
    }
  }
  if (timelineHeading === -1) {
    if (out[out.length - 1] !== '') out.push('');
    out.push('## Timeline');
    out.push('');
    out.push(line);
    if (out[out.length - 1] !== '') out.push('');
    return out;
  }
  let end = out.length;
  for (let i = timelineHeading + 1; i < out.length; i++) {
    if (/^##\s+/.test(out[i])) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt - 1 > timelineHeading && out[insertAt - 1].trim() === '') {
    insertAt--;
  }
  out.splice(insertAt, 0, line);
  return out;
}

/**
 * Disk-touching variant of the timeline append. Used by the CLI
 * `backfill-closed` verb; the GUI / standard close path goes through
 * `transitionStatus` which composes the pure helper inline.
 */
export async function appendTimelineEntry(readmePath: string, line: string): Promise<void> {
  return withFileQueue(readmePath, async () => {
    const raw = await fs.readFile(readmePath, 'utf8');
    const eol = detectEol(raw);
    const lines = raw.split(/\r?\n/);
    const out = appendTimelineLines(lines, line);
    await atomicWrite(readmePath, out.join(eol));
  });
}

/**
 * Parse the `## Timeline` section into a flat list of `{ date, text }`
 * entries, in source order. Returns an empty list when the section is
 * absent or empty. The date is the leading ISO `YYYY-MM-DD` token; the text
 * is whatever follows the em-dash separator (or the rest of the line, when
 * the entry doesn't follow the standard shape).
 *
 * Indented, non-empty lines following an entry are its wrapped remainder (the
 * conception hard-wraps long entries) and are folded back into that entry's
 * text, so multi-line entries aren't truncated. Flush-left lines that aren't a
 * dated bullet are skipped — this keeps the parser robust against hand-edited
 * prose between bullet lines.
 */
export function parseTimelineEntries(raw: string): { date: string; text: string }[] {
  const lines = raw.split(/\r?\n/);
  const out: { date: string; text: string }[] = [];
  let inTimeline = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      inTimeline = heading[1].trim().toLowerCase() === 'timeline';
      continue;
    }
    if (!inTimeline) continue;
    // Date + separator + text. The separator class accepts em-dash (the
    // canonical form `condash projects close` writes) and hyphen variants
    // for hand-edited entries. The close-specific subset must keep matching
    // `CLOSED_LINE` in shared/header.ts — that regex anchors only on the
    // em-dash because the `close` writer never emits a hyphen.
    const m = line.match(/^\s*-\s+(\d{4}-\d{2}-\d{2})\s+(?:—|--?)\s+(.+?)\s*$/);
    if (m) {
      out.push({ date: m[1], text: m[2] });
      continue;
    }
    // An indented, non-empty line is the wrapped continuation of the entry
    // above — fold it back in. Flush-left prose is left skipped.
    if (out.length > 0 && /^\s+\S/.test(line)) {
      out[out.length - 1].text += ' ' + line.trim();
    }
  }
  return out;
}

// Re-export so callers that import `parseTimelineEntries` from this module
// also reach the close-line regex through a stable surface, while the
// canonical literal still lives in shared/header.ts.
export { CLOSED_LINE };
