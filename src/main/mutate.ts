import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { StepMarker } from '../shared/types';
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
): Promise<void> {
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

export async function setStatus(path: string, newStatus: string): Promise<void> {
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
    const lines = raw.split(/\r?\n/);

    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break;
      const match = lines[i].match(STATUS_LINE_RE);
      if (match) {
        lines[i] = `${match[1]}${newStatus}`;
        updated = true;
        break;
      }
    }

    if (!updated) {
      throw new Error('No **Status**: line found in metadata block');
    }

    await atomicWrite(path, lines.join('\n'));
  });
}
