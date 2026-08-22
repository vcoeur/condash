import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { conceptionConfigCandidates } from './condash-dir';
import { pathExists } from './fs-helpers';

import type { ConceptionInitState } from '../shared/types';

/**
 * Path to the bundled conception-template/ tree.
 *
 * Three resolutions, in order:
 *   1. `CONDASH_TEMPLATE_ROOT` env override (same escape hatch
 *      `locateShippedSkillsRoot` honours, so tests and installs point at a
 *      non-default template).
 *   2. Electron main process: `app.getAppPath()` — the repo root in dev and
 *      the asar root in packaged builds (electron-builder copies
 *      `conception-template/**` per `electron-builder.yml`). Resolved through
 *      a lazy dynamic import instead of a top-level `import { app }` so the
 *      CLI bundle — which keeps `electron` external and must never touch it —
 *      never evaluates the module at load (mirrors user-data-dir.ts).
 *   3. `__dirname`-relative fallback for the CLI bundle — `dist-cli/condash.cjs`
 *      (and the packaged, asar-unpacked copy) sits one directory above the
 *      repo's conception-template/, exactly like `locateShippedSkillsRoot`.
 */
async function templateRoot(): Promise<string> {
  const override = process.env.CONDASH_TEMPLATE_ROOT;
  if (override) return override;
  try {
    const candidate: unknown = await import('electron');
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      'app' in candidate &&
      typeof (candidate as { app?: { getAppPath?: unknown } }).app?.getAppPath === 'function'
    ) {
      return join(
        (candidate as { app: { getAppPath(): string } }).app.getAppPath(),
        'conception-template',
      );
    }
  } catch {
    // import('electron') fails outside the Electron runtime — fall through.
  }
  return join(__dirname, '..', 'conception-template');
}

/** Probe a candidate workspace path for the conception markers. */
export async function detectConceptionState(path: string): Promise<ConceptionInitState> {
  let pathExists = false;
  try {
    const stat = await fs.stat(path);
    pathExists = stat.isDirectory();
  } catch {
    pathExists = false;
  }

  if (!pathExists) {
    return {
      pathExists: false,
      hasProjects: false,
      hasConfiguration: false,
      looksInitialised: false,
    };
  }

  const hasProjects = await isDirectory(join(path, 'projects'));
  // `.condash/settings.json` is canonical; `condash.json` and
  // `configuration.json` are legacy fallbacks (both read indefinitely).
  // Any of the candidates satisfies the marker.
  const configChecks = await Promise.all(conceptionConfigCandidates(path).map(isFile));
  const hasConfiguration = configChecks.some(Boolean);
  return {
    pathExists: true,
    hasProjects,
    hasConfiguration,
    looksInitialised: hasProjects && hasConfiguration,
  };
}

/**
 * Copy the bundled conception-template/ into `targetPath`, expanding the
 * `*.example` files (`condash.json.example` → `condash.json`,
 * `.claude/settings.example.json` → `.claude/settings.json`). `AGENTS.md`
 * is shipped under its real name with a `## General` heading wrapping the
 * shipped region, so `condash templates install` can push updates into
 * it without touching the user-owned `## Specifics` section.
 * Existing files are preserved — the init never overwrites.
 *
 * The `{{ conception_name }}` / `{{ description }}` tokens the template's
 * AGENTS.md opens with are filled in (audit D1) — the CLI install path
 * already substitutes them per-conception; init used to copy bytes
 * verbatim, so every fresh tree opened with literal placeholders.
 *
 * Returns the list of paths that were created (relative to `targetPath`).
 */
export async function initConception(targetPath: string): Promise<string[]> {
  const src = await templateRoot();
  await ensureDir(targetPath);
  const created: string[] = [];
  const tokens: TemplateTokens = {
    name: basename(targetPath),
    description: `Conception at ${targetPath} — projects and knowledge managed by condash.`,
  };
  await copyTreeRespecting(src, targetPath, '', created, tokens);
  return created;
}

/**
 * Guard for the renderer-initiated `initConception` IPC: the renderer may only
 * scaffold a directory the user actually picked in the native dialog this
 * session, and only when it exists as a directory. Without this the handler is
 * the one unbounded write in the IPC surface — a compromised renderer could
 * scaffold the template at any path (and `initConception` mkdir -p's its
 * target). The CLI's `condash init` deliberately creates its target and does
 * not go through this guard.
 *
 * @throws when no dialog pick is outstanding, `candidate` differs from it, or
 * `candidate` does not exist as a directory.
 */
export async function assertInitTargetAllowed(
  candidate: string,
  allowedPath: string | null,
): Promise<void> {
  if (allowedPath === null || candidate !== allowedPath) {
    throw new Error('initConception: path was not picked via the conception dialog');
  }
  if (!(await isDirectory(candidate))) {
    throw new Error(`initConception: not a directory — ${candidate}`);
  }
}

/** Per-conception values for the `{{ token }}` substitutions in AGENTS.md. */
interface TemplateTokens {
  name: string;
  description: string;
}

/**
 * Fill the `{{ conception_name }}` and `{{ description }}` tokens the
 * bundled template's AGENTS.md ships with: the conception's name and a
 * default description line. Any other `{{ token }}` occurrences are left
 * untouched.
 */
export function substituteTemplateTokens(text: string, name: string, description: string): string {
  return text
    .replaceAll('{{ conception_name }}', name)
    .replaceAll('{{ description }}', description);
}

async function copyTreeRespecting(
  srcRoot: string,
  dstRoot: string,
  rel: string,
  created: string[],
  tokens: TemplateTokens,
): Promise<void> {
  const srcDir = join(srcRoot, rel);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcRel = rel ? `${rel}/${entry.name}` : entry.name;
    const dstRel = mapTemplateName(srcRel);
    const srcAbs = join(srcRoot, srcRel);
    const dstAbs = join(dstRoot, dstRel);
    if (entry.isDirectory()) {
      await ensureDir(dstAbs);
      await copyTreeRespecting(srcRoot, dstRoot, srcRel, created, tokens);
      continue;
    }
    if (await pathExists(dstAbs)) continue;
    await ensureDir(dirname(dstAbs));
    if (srcRel === 'AGENTS.md') {
      const text = await fs.readFile(srcAbs, 'utf8');
      await fs.writeFile(
        dstAbs,
        substituteTemplateTokens(text, tokens.name, tokens.description),
        'utf8',
      );
    } else {
      await fs.copyFile(srcAbs, dstAbs);
    }
    if (entry.name.endsWith('.sh')) {
      await fs.chmod(dstAbs, 0o755);
    }
    created.push(dstRel);
  }
}

/** Drop the `.example` suffix on the known templated files. The bundled
 * conception-template ships `.condash/settings.json.example` and
 * `.claude/settings.example.json`; on init they materialise without
 * the `.example` segment. The older `condash.json.example` form is
 * still mapped so existing template clones keep working. */
function mapTemplateName(rel: string): string {
  if (rel === 'condash.json.example') return 'condash.json';
  if (rel === '.condash/settings.json.example') return '.condash/settings.json';
  if (rel === '.claude/settings.example.json') return '.claude/settings.json';
  return rel;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}
