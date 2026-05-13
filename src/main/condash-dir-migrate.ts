import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write';
import {
  CONDASH_DIR,
  condashDir,
  condashSettingsPath,
  legacyCondashJsonPath,
  legacyConfigurationJsonPath,
} from './condash-dir';

export interface MigrationResult {
  conception: string;
  /** True when a legacy file was actually copied. False when the primary
   * already existed, no legacy file was found, or the conception is empty. */
  migrated: boolean;
  /** Absolute path of the legacy file that was migrated (only when migrated). */
  from?: string;
  /** Absolute path of the new primary (only when migrated). */
  to?: string;
  /** True when `.gitignore` was created or appended to. */
  gitignoreUpdated: boolean;
  /** Diagnostic — why this call was a no-op. */
  reason?: 'primary-already-exists' | 'no-legacy-config';
}

const GITIGNORE_BLOCK = `# condash workspace state (auto-managed, per-host)\n.condash/\n`;

/** Match any line that mentions `.condash` as a directory pattern. Allows
 * optional leading slash and trailing slash; rejects comments. */
const GITIGNORE_PATTERN_RE = /(^|\n)[ \t]*\/?\.condash(\/|\b)/;

/**
 * Idempotent migration from a legacy conception-root config file
 * (`condash.json` or `configuration.json`) to the new canonical
 * `<conception>/.condash/settings.json`. Also wires `.gitignore` so the
 * `.condash/` tree (logs, future state) is ignored by default.
 *
 * Behaviour:
 *
 *   1. Skip when the primary already exists.
 *   2. Skip when neither legacy file exists.
 *   3. Otherwise: ensure `.condash/`, copy legacy → primary, replace the
 *      legacy file with a tombstone JSON object, and append the gitignore
 *      block when `.git/` is present and the pattern isn't already there.
 *
 * The tombstone keeps the legacy file present (its absence would be
 * surprising in `git status` for someone who tracked it) while preventing
 * accidental future edits from drifting: the tombstone's keys are all
 * `_moved_*` markers, and the reader treats any object made up entirely
 * of `_`-prefixed keys as empty.
 */
export async function migrateLegacyConfig(conception: string): Promise<MigrationResult> {
  const target = condashSettingsPath(conception);
  if (await pathExists(target)) {
    return {
      conception,
      migrated: false,
      gitignoreUpdated: false,
      reason: 'primary-already-exists',
    };
  }

  const legacyCandidates = [
    legacyCondashJsonPath(conception),
    legacyConfigurationJsonPath(conception),
  ];
  let source: string | undefined;
  let content: string | undefined;
  for (const candidate of legacyCandidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      // Skip files that are themselves tombstones (idempotency: a previous
      // partial migration may have tombstoned the legacy without writing
      // the primary).
      const parsed = safeParse(raw);
      if (parsed && isTombstone(parsed)) continue;
      content = raw;
      source = candidate;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  if (!source || content === undefined) {
    return { conception, migrated: false, gitignoreUpdated: false, reason: 'no-legacy-config' };
  }

  await fs.mkdir(condashDir(conception), { recursive: true });
  await atomicWrite(target, content);

  const now = new Date();
  const tombstone =
    JSON.stringify(
      {
        _: `Settings moved to ${CONDASH_DIR}/settings.json on ${now.toISOString().slice(0, 10)}. This file is no longer read by condash; delete it on your next commit.`,
        _moved_to: `${CONDASH_DIR}/settings.json`,
        _moved_at: now.toISOString(),
      },
      null,
      2,
    ) + '\n';
  await atomicWrite(source, tombstone);

  const gitignoreUpdated = await ensureGitignoreEntry(conception);

  return {
    conception,
    migrated: true,
    from: source,
    to: target,
    gitignoreUpdated,
  };
}

/**
 * Append a `.condash/` block to the conception's `.gitignore`. No-op when
 * the pattern is already present, when the file is in a non-git folder,
 * or when an existing line covers `.condash`. Returns true when the file
 * was created or appended to.
 */
export async function ensureGitignoreEntry(conception: string): Promise<boolean> {
  // Only act when the conception is a git repo. A worktree counts: `.git`
  // there is a file pointing at the canonical gitdir.
  if (!existsSync(join(conception, '.git'))) return false;

  const gitignorePath = join(conception, '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (GITIGNORE_PATTERN_RE.test(existing)) return false;

  let updated: string;
  if (existing.length === 0) {
    updated = GITIGNORE_BLOCK;
  } else if (existing.endsWith('\n')) {
    updated = existing + '\n' + GITIGNORE_BLOCK;
  } else {
    updated = existing + '\n\n' + GITIGNORE_BLOCK;
  }

  await atomicWrite(gitignorePath, updated);
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isTombstone(obj: Record<string, unknown>): boolean {
  if (Object.keys(obj).length === 0) return false;
  for (const key of Object.keys(obj)) {
    if (!key.startsWith('_')) return false;
  }
  return true;
}
