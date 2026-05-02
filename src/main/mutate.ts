import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { StepMarker, TransitionResult } from '../shared/types';
import { configSchema } from './config-schema';

const STEP_LINE_RE = /^(\s*-\s\[)([ ~x-])(\]\s.*)$/;
const STEP_LINE_FULL_RE = /^(\s*-\s\[)([ ~x-])(\]\s)(.*)$/;
const STATUS_LINE_RE = /^(\*\*Status\*\*\s*:\s*)([^\s]+)\s*$/i;
const HEADING2_RE = /^##\s+(.+)$/;

const queues = new Map<string, Promise<unknown>>();

/**
 * Serialise writes per file path so concurrent toggles don't fight each other.
 * The IPC handler awaits the returned promise; the renderer sees a clean error if
 * one mutation fails in the queue.
 */
async function withFileQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.then(work, work);
  queues.set(
    path,
    next.finally(() => {
      if (queues.get(path) === next) queues.delete(path);
    }),
  );
  return next as Promise<T>;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}

export async function toggleStep(
  path: string,
  lineIndex: number,
  expectedMarker: StepMarker,
  newMarker: StepMarker,
): Promise<void> {
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
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

    lines[lineIndex] = `${match[1]}${newMarker}${match[3]}`;
    await atomicWrite(path, lines.join('\n'));
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
    const lines = raw.split(/\r?\n/);

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`Line index ${lineIndex} out of range`);
    }

    const match = lines[lineIndex].match(STEP_LINE_FULL_RE);
    if (!match) {
      throw new Error(`Line ${lineIndex} is not a step`);
    }
    if (match[4].trim() !== expectedText.trim()) {
      throw new Error(
        `Drift: step text at line ${lineIndex} doesn't match expected text — reload before editing`,
      );
    }

    lines[lineIndex] = `${match[1]}${match[2]}${match[3]}${trimmed}`;
    await atomicWrite(path, lines.join('\n'));
  });
}

/**
 * Append a new `- [ ] text` line to the `## Steps` section. Inserts after
 * the last existing step in that section; if there are no steps yet, appends
 * at the end of the section (or end of file when the section is the last one).
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
    const lines = raw.split(/\r?\n/);

    let stepsStart = -1;
    let stepsEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
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

    if (stepsStart === -1) {
      throw new Error('No "## Steps" section found');
    }

    let insertAt = -1;
    for (let i = stepsEnd - 1; i > stepsStart; i--) {
      if (STEP_LINE_RE.test(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt === -1) {
      // No step yet — drop the new step right under the heading, with a
      // blank line of breathing room if the next line isn't already blank.
      insertAt = stepsStart + 1;
      while (insertAt < stepsEnd && lines[insertAt].trim() === '') insertAt++;
    } else {
      // Trim trailing blank lines so the insert sits flush with the existing list.
      while (insertAt - 1 > stepsStart && lines[insertAt - 1].trim() === '') {
        insertAt--;
      }
    }

    const newLine = `- [ ] ${trimmed}`;
    lines.splice(insertAt, 0, newLine);
    await atomicWrite(path, lines.join('\n'));
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

    const finalContent =
      basename(path) === 'configuration.json'
        ? validateAndCanonicaliseConfig(newContent)
        : newContent;
    await atomicWrite(path, finalContent);
    return finalContent;
  });
}

function validateAndCanonicaliseConfig(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    throw new Error(`configuration.json: ${where} — ${issue.message}`);
  }
  return JSON.stringify(result.data, null, 2) + '\n';
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
  return withFileQueue(readmePath, async () => {
    const raw = await fs.readFile(readmePath, 'utf8');
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

    await atomicWrite(readmePath, lines.join('\n'));
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
    const lines = raw.split(/\r?\n/);
    const out = appendTimelineLines(lines, line);
    await atomicWrite(readmePath, out.join('\n'));
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

function isoToday(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
