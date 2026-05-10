/**
 * Shared internals for the conception-tree audit checks
 * (lfs / binaries / cross-repo / worktrees / index). Public types,
 * thresholds, the conception-config reader, the LFS / in-scope file
 * listings, and the disk-walking helpers live here so each check module
 * can stay focused on its own concern.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { exec } from '../exec';
import type { ConfigShape } from '../config-walk';
import { getEffectiveConceptionConfig } from '../effective-config';

export type AuditCheckName = 'lfs' | 'binaries' | 'cross-repo' | 'worktrees' | 'index';

export interface AuditIssue {
  check: AuditCheckName | string;
  severity: 'error' | 'warn' | 'info';
  /** Path relative to the conception root (or absolute when outside it). */
  file: string | null;
  line: number | null;
  message: string;
  /**
   * Hint for the consuming skill on what kind of fix applies. Always present;
   * `autoFix: false` flags issues that need human judgment (a punch-list item).
   * `autoFix: true` flags issues a skill can mechanically apply once batched
   * confirmation is given.
   */
  fix: { action: string; autoFix: boolean; [key: string]: unknown };
}

export interface AuditReport {
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byCheck: Record<string, number>;
    conceptionRoot: string;
    checksRun: string[];
  };
  issues: AuditIssue[];
}

export const LARGE_BIN_KB = 50;
export const BIN_EXTS = ['.pdf', '.png', '.jpg', '.jpeg'];
export const SKIP_SCAN_DIRS = new Set(['.git', 'node_modules', 'local', '.cache']);

export async function readConfig(
  conceptionPath: string,
): Promise<ConfigShape & { worktrees_path?: string }> {
  return (await getEffectiveConceptionConfig(conceptionPath)) as ConfigShape & {
    worktrees_path?: string;
  };
}

export async function listLfsFiles(conceptionPath: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await exec('git', ['lfs', 'ls-files', '-n'], {
      cwd: conceptionPath,
      maxBuffer: 4 * 1024 * 1024,
    });
    const set = new Set<string>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed);
    }
    return set;
  } catch {
    return null;
  }
}

export async function listInScopeFiles(conceptionPath: string): Promise<Set<string>> {
  // Tracked + untracked-not-gitignored. Exhaustive enough for the scan.
  try {
    const { stdout } = await exec(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: conceptionPath, maxBuffer: 16 * 1024 * 1024 },
    );
    const set = new Set<string>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed);
    }
    return set;
  } catch {
    return new Set();
  }
}

export async function collectFilesByExt(root: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  await walk(root);
  return out.sort();

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_SCAN_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (exts.some((e) => lower.endsWith(e))) out.push(full);
      }
    }
  }
}

export async function listAllSubdirs(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root);
  return out;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (SKIP_SCAN_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      out.push(full);
      await walk(full);
    }
  }
}
