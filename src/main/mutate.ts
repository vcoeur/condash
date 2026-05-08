import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { StepMarker, TransitionResult } from '../shared/types';
import { KNOWN_STATUSES, STEP_MARKERS } from '../shared/types';
import { isoToday } from '../shared/iso-today';
import { atomicWrite } from './atomic-write';
import {
  validateAndCanonicaliseConfig,
  validateAndCanonicaliseGlobalSettings,
} from './config-schema';

// One regex for both shapes: capture the step text in group 4 so callers
// that need the body text use it; callers that only need the marker can
// ignore the trailing group. Replaces a near-byte-identical pair where
// the only difference was whether `(.*)` lived inside or outside the
// `]\s` capture — easy to drift, never observed working independently.
const STEP_LINE_RE = /^(\s*-\s\[)([ ~x-])(\]\s)(.*)$/;
const STATUS_LINE_RE = /^(\*\*Status\*\*\s*:\s*)(\S+)\s*$/i;
const HEADING2_RE = /^##\s+(.+)$/;

/**
 * Detect the line ending used in `raw`. Files authored on Windows with
 * `core.autocrlf=false` ship CRLF; rejoining with `\n` would flip the entire
 * file on every step toggle and the user would see a whole-file diff in
 * `git status`. Returns `'\r\n'` if any CRLF is present, otherwise `'\n'`.
 */
function detectEol(raw: string): '\n' | '\r\n' {
  return /\r\n/.test(raw) ? '\r\n' : '\n';
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Serialise writes per file path so concurrent toggles don't fight each other.
 * A failure in `work` doesn't poison the queue — the next caller re-runs against
 * fresh state — but each caller still sees its own error. The renderer surfaces
 * a clean message either way.
 */
async function withFileQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  // Swallow the previous run's error for queueing purposes (so a failed mutation
  // doesn't block subsequent ones), then run our own work and rethrow any error
  // the caller cares about.
  const next: Promise<T> = prev.catch(() => undefined).then(work);
  queues.set(
    path,
    next.finally(() => {
      if (queues.get(path) === next) queues.delete(path);
    }),
  );
  return next;
}

export async function toggleStep(
  path: string,
  lineIndex: number,
  expectedMarker: StepMarker,
  newMarker: StepMarker,
): Promise<void> {
  // Runtime-validate both markers — the StepMarker TS type narrows at
  // compile time but a hostile (or buggy) renderer could pass any string
  // through the IPC boundary, and the marker is written verbatim into
  // the README ("- [<m>] …"). Reject anything that's not in STEP_MARKERS.
  // Don't echo the raw value in the error — it crossed the IPC boundary
  // unvalidated; reflecting it back leaks renderer input shape into logs.
  const markerHint = `(expected one of '${STEP_MARKERS.join("', '")}')`;
  if (!(STEP_MARKERS as readonly string[]).includes(expectedMarker)) {
    throw new Error(`toggleStep: invalid expectedMarker ${markerHint}`);
  }
  if (!(STEP_MARKERS as readonly string[]).includes(newMarker)) {
    throw new Error(`toggleStep: invalid newMarker ${markerHint}`);
  }
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
    const eol = detectEol(raw);
    const lines = raw.split(/\r?\n/);

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`Line index ${lineIndex} out of range`);
    }

    const match = lines[lineIndex].match(STEP_LINE_RE);
    if (!match) {
      throw new Error(`Line ${lineIndex} is not a step`);
    }
    if (match[2] !== expectedMarker) {
      throw new Error(
        `Drift: expected marker '${expectedMarker}' at line ${lineIndex} but found '${match[2]}'`,
      );
    }

    lines[lineIndex] = `${match[1]}${newMarker}${match[3]}${match[4]}`;
    await atomicWrite(path, lines.join(eol));
  });
}

export async function editStepText(
  path: string,
  lineIndex: number,
  expectedText: string,
  newText: string,
): Promise<void> {
  const trimmed = newText.trim();
  if (!trimmed) {
    throw new Error('Step text cannot be empty');
  }
  if (/\r|\n/.test(trimmed)) {
    throw new Error('Step text cannot contain line breaks');
  }
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
    const eol = detectEol(raw);
    const lines = raw.split(/\r?\n/);

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`Line index ${lineIndex} out of range`);
    }

    const match = lines[lineIndex].match(STEP_LINE_RE);
    if (!match) {
      throw new Error(`Line ${lineIndex} is not a step`);
    }
    if (match[4].trim() !== expectedText.trim()) {
      throw new Error(
        `Drift: step text at line ${lineIndex} doesn't match expected text — reload before editing`,
      );
    }

    lines[lineIndex] = `${match[1]}${match[2]}${match[3]}${trimmed}`;
    await atomicWrite(path, lines.join(eol));
  });
}

/**
 * Append a new `- [ ] text` line to the `## Steps` section. Inserts after
 * the last existing step in that section; if the section has no steps yet,
 * inserts directly under the heading and (if needed) leaves a blank line
 * separating the new step from the next section. Creates the section at
 * end-of-file when the README has no `## Steps` heading at all.
 */
export async function addStep(path: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Step text cannot be empty');
  }
  if (/\r|\n/.test(trimmed)) {
    throw new Error('Step text cannot contain line breaks');
  }
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
    const eol = detectEol(raw);
    const lines = raw.split(/\r?\n/);

    let stepsStart = -1;
    let stepsEnd = lines.length;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      // Triple-backtick or triple-tilde fenced code blocks can contain `##`
      // lines that aren't headings (a Markdown example, a shell prompt).
      // Track fence state so we don't pick those up as section anchors.
      if (/^\s*(```|~~~)/.test(lines[i])) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const heading = lines[i].match(HEADING2_RE);
      if (!heading) continue;
      if (stepsStart === -1 && heading[1].trim().toLowerCase() === 'steps') {
        stepsStart = i;
        continue;
      }
      if (stepsStart !== -1) {
        stepsEnd = i;
        break;
      }
    }

    const newLine = `- [ ] ${trimmed}`;

    if (stepsStart === -1) {
      // No `## Steps` section yet. Append one at the end of the file. Leave
      // a blank line above the new heading if the file doesn't already end
      // with one, so the section doesn't glue itself to whatever came before.
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      if (lines.length > 0) lines.push('');
      lines.push('## Steps');
      lines.push('');
      lines.push(newLine);
      lines.push('');
      await atomicWrite(path, lines.join(eol));
      return;
    }

    let insertAt = -1;
    for (let i = stepsEnd - 1; i > stepsStart; i--) {
      if (STEP_LINE_RE.test(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt === -1) {
      // Section has no step yet — collapse any blank lines between the
      // heading and the next section, then re-emit `<blank>, step, <blank>`
      // so the new step sits one line below `## Steps` and one above
      // whatever follows.
      let blankRunEnd = stepsStart + 1;
      while (blankRunEnd < stepsEnd && lines[blankRunEnd].trim() === '') {
        blankRunEnd++;
      }
      const replacement: string[] = ['', newLine];
      // If a sibling section follows (rather than EOF), keep a blank line
      // separator. EOF doesn't need a trailing blank — `lines.join('\n')`
      // emits the final newline already if the file ended with one.
      if (blankRunEnd < lines.length) replacement.push('');
      lines.splice(stepsStart + 1, blankRunEnd - (stepsStart + 1), ...replacement);
    } else {
      // Trim trailing blank lines so the insert sits flush with the existing list.
      while (insertAt - 1 > stepsStart && lines[insertAt - 1].trim() === '') {
        insertAt--;
      }
      lines.splice(insertAt, 0, newLine);
    }

    await atomicWrite(path, lines.join(eol));
  });
}

export async function writeNote(
  path: string,
  expectedContent: string,
  newContent: string,
): Promise<string> {
  return withFileQueue(path, async () => {
    let onDisk = '';
    try {
      onDisk = await fs.readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // File doesn't exist yet — expected baseline must also be empty.
    }
    if (onDisk !== expectedContent) {
      throw new Error('File on disk has drifted; reload before saving');
    }

    const baseName = basename(path);
    const isConceptionConfig = baseName === 'condash.json' || baseName === 'configuration.json';
    const isGlobalSettings = baseName === 'settings.json';
    let finalContent: string;
    if (isConceptionConfig) {
      finalContent = validateAndCanonicaliseConfig(newContent);
    } else if (isGlobalSettings) {
      finalContent = validateAndCanonicaliseGlobalSettings(newContent);
    } else {
      finalContent = newContent;
    }
    await atomicWrite(path, finalContent);
    return finalContent;
  });
}

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
    if (!updated) {
      throw new Error('No **Status**: line found in metadata block');
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
 * Backwards-compatible thin wrapper around `transitionStatus`. Existing
 * callers that don't care about the result (CLI status-set legacy path, IPC
 * handler typed as `Promise<void>`) keep working without rewrites — the
 * timeline-append behaviour kicks in automatically because the wrapper goes
 * through the same primitive.
 */
export async function setStatus(path: string, newStatus: string): Promise<TransitionResult> {
  return transitionStatus(path, newStatus);
}

/**
 * Append a single timeline line (`- <date> — <text>`) to the `## Timeline`
 * section of a README. Returns the new lines array; does not write to disk.
 * Pure helper extracted out of the CLI's close verb so `transitionStatus`
 * and CLI's `backfill-closed` can share one insertion algorithm.
 *
 * Insertion is bottom-of-section: the new line lands after the last existing
 * entry but before the trailing blank lines, preserving the conventional
 * blank-line gap before the next ## section. When the README has no
 * `## Timeline` section, one is appended at the end of the file.
 */
export function appendTimelineLines(lines: readonly string[], line: string): string[] {
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
 * Disk-touching variant of `appendTimelineLines`. Used by the CLI
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
 * Lines that don't match the expected `- <date> — <text>` shape are skipped
 * — this keeps the parser robust against hand-edited prose between bullet
 * lines.
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
    const m = line.match(/^\s*-\s+(\d{4}-\d{2}-\d{2})\s+(?:—|--?)\s+(.+?)\s*$/);
    if (!m) continue;
    out.push({ date: m[1], text: m[2] });
  }
  return out;
}
