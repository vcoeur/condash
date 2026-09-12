/**
 * Shared scaffolding for CLI handler tests.
 *
 * Pattern:
 *
 *   beforeEach(async () => { conceptionPath = await makeTmpConception(); });
 *   afterEach(async () => { await rmConception(conceptionPath); });
 *
 *   const { stdout, threw } = await captureStdout(() =>
 *     someCommand({ ... }, ctx(), conceptionPath),
 *   );
 *   const data = parseJsonEnvelope(stdout);
 *
 * Each helper does one thing — tests assemble the bits they need.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OutputContext } from '../output';

/**
 * Scaffold a tmpdir with the conception skeleton CLI commands expect:
 * `projects/`, `knowledge/`, and an empty `condash.json`. Commands that
 * need more (settings.json, repos, etc.) layer on top.
 */
export async function makeTmpConception(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'condash-cli-test-'));
  await fs.mkdir(join(root, 'projects'), { recursive: true });
  await fs.mkdir(join(root, 'knowledge'), { recursive: true });
  await fs.writeFile(join(root, 'condash.json'), '{}\n', 'utf8');
  return root;
}

export async function rmConception(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

export interface ProjectReadmeFields {
  date: string;
  kind?: string;
  status?: string;
  apps?: string[];
  branch?: string;
  base?: string;
  /** H1 title — defaults to the slug. */
  title?: string;
  /** Body markdown appended after the header. Sections, steps, etc. */
  body?: string;
}

/**
 * Write a YAML-frontmatter project README under
 * `<conception>/projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/README.md` and return
 * the absolute path. Caller picks `date` (used for both the YAML field and
 * the folder name) + `slug`.
 */
export async function writeProjectReadme(
  conceptionPath: string,
  slug: string,
  fields: ProjectReadmeFields,
): Promise<string> {
  const month = fields.date.slice(0, 7);
  const folder = `${fields.date}-${slug}`;
  const dir = join(conceptionPath, 'projects', month, folder);
  await fs.mkdir(dir, { recursive: true });

  const front: string[] = ['---', `date: ${fields.date}`];
  if (fields.kind) front.push(`kind: ${fields.kind}`);
  if (fields.status) front.push(`status: ${fields.status}`);
  if (fields.apps && fields.apps.length > 0) {
    front.push('apps:');
    for (const app of fields.apps) front.push(`  - ${app}`);
  }
  if (fields.branch) front.push(`branch: ${fields.branch}`);
  if (fields.base) front.push(`base: ${fields.base}`);
  front.push('---', '');
  front.push(`# ${fields.title ?? slug}`);
  if (fields.body) {
    front.push('');
    front.push(fields.body);
  }
  const readmePath = join(dir, 'README.md');
  await fs.writeFile(readmePath, front.join('\n') + '\n', 'utf8');
  return readmePath;
}

/**
 * Write a file under `<conception>/knowledge/<relPath>`. Creates parent
 * directories as needed.
 */
export async function writeKnowledgeFile(
  conceptionPath: string,
  relPath: string,
  content: string,
): Promise<string> {
  const full = join(conceptionPath, 'knowledge', relPath);
  await fs.mkdir(dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  return full;
}

/** Default `OutputContext` for JSON-mode tests — quiet, no colour. */
export function jsonCtx(): OutputContext {
  return { json: true, ndjson: false, quiet: true, noColor: true };
}

/** Default `OutputContext` for human-text tests. */
export function humanCtx(): OutputContext {
  return { json: false, ndjson: false, quiet: true, noColor: true };
}

export interface Captured {
  stdout: string;
  stderr: string;
  threw: unknown;
}

interface CaptureFrame {
  readonly stdout: string[];
  readonly stderr: string[];
}

/** Associates asynchronous writes with the capture that started their work. */
const captureContext = new AsyncLocalStorage<CaptureFrame>();
const captureStack: CaptureFrame[] = [];
let originalOut: typeof process.stdout.write | undefined;
let originalErr: typeof process.stderr.write | undefined;

/** Return whether a frame remains live in the scoped capture stack. */
function isActiveCapture(frame: CaptureFrame): boolean {
  return captureStack.includes(frame);
}

/** Append a stream chunk to its owning frame, discarding work from a retired one. */
function captureWrite(stream: 'stdout' | 'stderr', data: string | Uint8Array): boolean {
  const contextualFrame = captureContext.getStore();
  if (contextualFrame && !isActiveCapture(contextualFrame)) return true;

  const frame = contextualFrame ?? captureStack.at(-1);
  if (!frame) return false;

  const chunks = stream === 'stdout' ? frame.stdout : frame.stderr;
  chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  return true;
}

/** Restore the real stream writers only after the outermost capture finishes. */
function removeCapture(frame: CaptureFrame): void {
  const frameIndex = captureStack.lastIndexOf(frame);
  if (frameIndex === -1) return;
  captureStack.splice(frameIndex, 1);
  if (captureStack.length !== 0) return;

  if (originalOut) process.stdout.write = originalOut;
  if (originalErr) process.stderr.write = originalErr;
  originalOut = undefined;
  originalErr = undefined;
}

/**
 * Run `fn`, capture everything it writes to stdout + stderr, and surface
 * any thrown error rather than letting it escape. Mirrors the pattern in
 * `projects-create.test.ts` but covers stderr too — error envelopes from
 * `reportError` land there.
 */
export function captureStdout(fn: () => Promise<void> | void): Promise<Captured> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    const frame: CaptureFrame = { stdout: out, stderr: err };
    if (!originalOut || !originalErr) {
      originalOut = process.stdout.write;
      originalErr = process.stderr.write;
    }
    process.stdout.write = ((data: string | Uint8Array) => {
      if (captureWrite('stdout', data)) return true;
      return originalOut?.call(process.stdout, data) ?? true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((data: string | Uint8Array) => {
      if (captureWrite('stderr', data)) return true;
      return originalErr?.call(process.stderr, data) ?? true;
    }) as typeof process.stdout.write;
    captureStack.push(frame);

    captureContext
      .run(frame, () => Promise.resolve().then(fn))
      .then(
        () => {
          removeCapture(frame);
          resolve({ stdout: out.join(''), stderr: err.join(''), threw: undefined });
        },
        (e) => {
          removeCapture(frame);
          resolve({ stdout: out.join(''), stderr: err.join(''), threw: e });
        },
      );
  });
}

export interface JsonEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  warnings?: string[];
  error?: { code: string; message: string; [k: string]: unknown };
}

/** Parse the single-line JSON envelope from a `--json` mode command. */
export function parseJsonEnvelope<T = unknown>(stdout: string): JsonEnvelope<T> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('parseJsonEnvelope: empty stdout');
  return JSON.parse(trimmed) as JsonEnvelope<T>;
}
