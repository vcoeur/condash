import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { StepMarker } from '../shared/types';
import { canonicaliseOpenWith, configSchema } from './config-schema';

const STEP_LINE_RE = /^(\s*-\s\[)([ ~x-])(\]\s.*)$/;
const STATUS_LINE_RE = /^(\*\*Status\*\*\s*:\s*)([^\s]+)\s*$/i;

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
  // Migrate `commands → command` while we're here.
  return JSON.stringify(canonicaliseOpenWith(result.data), null, 2) + '\n';
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
