/**
 * Conception-tree audit checks. Port of the legacy `.claude/scripts/audit.py`
 * to TypeScript so every conception convention check lives in one parser.
 *
 * Checks:
 *  - `lfs`        — `*.pdf|*.png|*.jpg|*.jpeg` under `projects/` not tracked
 *                   by git-lfs.
 *  - `binaries`   — same extensions over 50 kB, not in lfs (informational;
 *                   usually downstream of `lfs`).
 *  - `cross-repo` — sibling app `CLAUDE.md` references `../../conception/...`
 *                   and the target doesn't resolve.
 *  - `worktrees`  — items with an active `**Branch**` field but no on-disk
 *                   worktree at `<worktrees_path>/<branch>/`. (Only items
 *                   whose Status is not `done` are checked.)
 *  - `index`      — every directory under `knowledge/` carries an `index.md`
 *                   listing its children; flag dangling and orphan entries.
 *
 * Stamps live in `condash knowledge verify` — not duplicated here. The audit
 * verb composes that one too via the same envelope.
 *
 * Pure read-only. Returns `{summary, issues[]}` so the CLI can either pretty-
 * print it or hand it to the skill verbatim.
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findProjectReadmes } from './walk';
import { readHeader } from '../cli/header';
import type { ConfigShape } from './config-walk';

const exec = promisify(execFile);

export type AuditCheckName = 'lfs' | 'binaries' | 'cross-repo' | 'worktrees' | 'index';

export interface AuditIssue {
  check: AuditCheckName | string;
  severity: 'error' | 'warn' | 'info';
  /** Path relative to the conception root (or absolute when outside it). */
  file: string | null;
  line: number | null;
  message: string;
  /** Hint for the consuming skill on what kind of fix applies. */
  fix?: { action: string; [key: string]: unknown };
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

const LARGE_BIN_KB = 50;
const BIN_EXTS = ['.pdf', '.png', '.jpg', '.jpeg'];
const SKIP_SCAN_DIRS = new Set(['.git', 'node_modules', 'local', '.cache']);

export async function runAudit(
  conceptionPath: string,
  checks: AuditCheckName[],
): Promise<AuditReport> {
  const issues: AuditIssue[] = [];
  for (const check of checks) {
    try {
      switch (check) {
        case 'lfs':
          issues.push(...(await checkLfs(conceptionPath)));
          break;
        case 'binaries':
          issues.push(...(await checkBinaries(conceptionPath)));
          break;
        case 'cross-repo':
          issues.push(...(await checkCrossRepo(conceptionPath)));
          break;
        case 'worktrees':
          issues.push(...(await checkWorktrees(conceptionPath)));
          break;
        case 'index':
          issues.push(...(await checkIndex(conceptionPath)));
          break;
        default:
          issues.push({
            check,
            severity: 'error',
            file: null,
            line: null,
            message: `unknown check: ${check}`,
          });
      }
    } catch (err) {
      issues.push({
        check,
        severity: 'error',
        file: null,
        line: null,
        message: `check crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const bySeverity: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  for (const i of issues) {
    bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    byCheck[i.check] = (byCheck[i.check] ?? 0) + 1;
  }
  return {
    summary: {
      total: issues.length,
      bySeverity,
      byCheck,
      conceptionRoot: conceptionPath,
      checksRun: checks,
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// `lfs` — coverage of binary files under projects/
// ---------------------------------------------------------------------------

async function checkLfs(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const projectsDir = join(conceptionPath, 'projects');
  if (!(await pathExists(projectsDir))) return issues;
  const tracked = await listLfsFiles(conceptionPath);
  if (tracked === null) {
    return [
      {
        check: 'lfs',
        severity: 'info',
        file: null,
        line: null,
        message: 'git-lfs not available; skipping LFS check',
      },
    ];
  }
  const inScope = await listInScopeFiles(conceptionPath);
  const matches = await collectFilesByExt(projectsDir, BIN_EXTS);
  for (const abs of matches) {
    const rel = relative(conceptionPath, abs);
    if (!inScope.has(rel)) continue;
    if (tracked.has(rel)) continue;
    let sizeKb = 0;
    try {
      const stat = await fs.stat(abs);
      sizeKb = stat.size / 1024;
    } catch {
      continue;
    }
    issues.push({
      check: 'lfs',
      severity: 'warn',
      file: rel,
      line: null,
      message: `${rel} (${sizeKb.toFixed(0)} kB) is not tracked by git-lfs`,
      fix: { action: 'lfs_track_path', path: rel, sizeKb: Math.round(sizeKb) },
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// `binaries` — > 50 kB, not in lfs (informational)
// ---------------------------------------------------------------------------

async function checkBinaries(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const projectsDir = join(conceptionPath, 'projects');
  if (!(await pathExists(projectsDir))) return issues;
  const tracked = (await listLfsFiles(conceptionPath)) ?? new Set<string>();
  const inScope = await listInScopeFiles(conceptionPath);
  const matches = await collectFilesByExt(projectsDir, BIN_EXTS);
  for (const abs of matches) {
    const rel = relative(conceptionPath, abs);
    if (!inScope.has(rel)) continue;
    if (tracked.has(rel)) continue;
    let sizeKb = 0;
    try {
      const stat = await fs.stat(abs);
      sizeKb = stat.size / 1024;
    } catch {
      continue;
    }
    if (sizeKb <= LARGE_BIN_KB) continue;
    issues.push({
      check: 'binaries',
      severity: 'info',
      file: rel,
      line: null,
      message: `${rel} is ${sizeKb.toFixed(0)} kB (> ${LARGE_BIN_KB} kB review threshold, not in git-lfs)`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// `cross-repo` — sibling-app CLAUDE.md → conception path resolution
// ---------------------------------------------------------------------------

async function checkCrossRepo(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const config = await readConfig(conceptionPath);
  const workspace = config.workspace_path;
  if (!workspace) return issues;
  const apps = await listSiblingApps(workspace, conceptionPath);
  const refRe = /\(((?:\.\.\/)+conception\/[^)\s]+)\)/g;
  for (const claudePath of apps) {
    let raw: string;
    try {
      raw = await fs.readFile(claudePath, 'utf8');
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    refRe.lastIndex = 0;
    while ((match = refRe.exec(raw))) {
      const ref = match[1];
      const target = resolve(dirname(claudePath), ref);
      const exists = await pathExists(target);
      if (exists) continue;
      const lineNo = raw.slice(0, match.index).split('\n').length;
      issues.push({
        check: 'cross-repo',
        severity: 'warn',
        file: claudePath,
        line: lineNo,
        message: `Reference to ${ref} does not resolve`,
        fix: { action: 'flag_for_user_edit', ref, inFile: claudePath },
      });
    }
  }
  return issues;
}

async function listSiblingApps(workspace: string, conceptionPath: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(workspace, { withFileTypes: true });
  } catch {
    return out;
  }
  const conceptionName = relative(workspace, conceptionPath);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === conceptionName) continue;
    if (SKIP_SCAN_DIRS.has(entry.name)) continue;
    const appDir = join(workspace, entry.name);
    for (const sub of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
      const candidate = join(appDir, sub);
      if (await pathExists(candidate)) out.push(candidate);
    }
    // One level down for monorepo-ish layouts.
    let inner: import('node:fs').Dirent[];
    try {
      inner = await fs.readdir(appDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const innerEntry of inner) {
      if (!innerEntry.isDirectory()) continue;
      if (innerEntry.name.startsWith('.')) continue;
      const innerDir = join(appDir, innerEntry.name);
      for (const sub of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
        const candidate = join(innerDir, sub);
        if (await pathExists(candidate)) out.push(candidate);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `worktrees` — items declaring **Branch** but missing on-disk worktree
// ---------------------------------------------------------------------------

async function checkWorktrees(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const config = await readConfig(conceptionPath);
  const worktreesPath =
    typeof config.worktrees_path === 'string'
      ? config.worktrees_path
      : join(process.env.HOME ?? '', 'src', 'worktrees');
  const readmes = await findProjectReadmes(conceptionPath);
  for (const readme of readmes) {
    const header = await readHeader(readme).catch(() => null);
    if (!header) continue;
    if (header.status === 'done') continue;
    if (!header.branch) continue;
    const wt = join(worktreesPath, header.branch);
    if (await pathExists(wt)) continue;
    issues.push({
      check: 'worktrees',
      severity: 'info',
      file: relative(conceptionPath, readme),
      line: null,
      message: `Item declares Branch '${header.branch}' but no worktree at ${wt}`,
      fix: { action: 'offer_worktree_setup', branch: header.branch },
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// `index` — knowledge/**/index.md cross-check (dangling + orphans)
// ---------------------------------------------------------------------------

async function checkIndex(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const knowledgeRoot = join(conceptionPath, 'knowledge');
  if (!(await pathExists(knowledgeRoot))) {
    issues.push({
      check: 'index',
      severity: 'error',
      file: 'knowledge/',
      line: null,
      message: 'knowledge/ directory missing',
    });
    return issues;
  }
  const dirs = [knowledgeRoot, ...(await listAllSubdirs(knowledgeRoot))];
  const indexedByDir = new Map<string, Set<string>>();
  for (const d of dirs.sort()) {
    const idx = join(d, 'index.md');
    if (!(await pathExists(idx))) {
      issues.push({
        check: 'index',
        severity: 'warn',
        file: relative(conceptionPath, idx),
        line: null,
        message: `Directory has no index.md — run condash knowledge index`,
      });
      continue;
    }
    indexedByDir.set(d, new Set<string>());
  }
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  for (const [d, entries] of indexedByDir) {
    const idx = join(d, 'index.md');
    const text = await fs.readFile(idx, 'utf8');
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(text))) {
      const rawLink = m[2].split('#')[0].split(' ')[0];
      if (!rawLink || /^(https?|mailto):/i.test(rawLink)) continue;
      if (rawLink.startsWith('../') || rawLink.startsWith('/')) continue;
      const target = resolve(d, rawLink);
      const relToD = relative(d, target).split(/[\\/]/);
      const isBody = relToD.length === 1 && relToD[0].endsWith('.md') && relToD[0] !== 'index.md';
      const isSubindex = relToD.length === 2 && relToD[1] === 'index.md';
      if (!isBody && !isSubindex) continue;
      const lineNo = text.slice(0, m.index).split('\n').length;
      if (!(await pathExists(target))) {
        issues.push({
          check: 'index',
          severity: 'warn',
          file: relative(conceptionPath, idx),
          line: lineNo,
          message: `Index entry [${m[1]}](${rawLink}) points to a file that does not exist`,
          fix: { action: 'remove_index_line', path: rawLink, label: m[1] },
        });
        continue;
      }
      entries.add(relative(conceptionPath, target));
    }
  }
  // Orphans: a body file present on disk that no parent index references.
  for (const [d, entries] of indexedByDir) {
    let dirEntries: import('node:fs').Dirent[];
    try {
      dirEntries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of dirEntries) {
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      if (e.name === 'index.md') continue;
      const rel = relative(conceptionPath, join(d, e.name));
      if (!entries.has(rel)) {
        issues.push({
          check: 'index',
          severity: 'warn',
          file: rel,
          line: null,
          message: `Body file not referenced from ${relative(conceptionPath, d)}/index.md — run condash knowledge index`,
          fix: { action: 'run_knowledge_index', path: rel },
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readConfig(
  conceptionPath: string,
): Promise<ConfigShape & { worktrees_path?: string }> {
  const path = join(conceptionPath, 'configuration.json');
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as ConfigShape & { worktrees_path?: string };
  } catch {
    return {};
  }
}

async function listLfsFiles(conceptionPath: string): Promise<Set<string> | null> {
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

async function listInScopeFiles(conceptionPath: string): Promise<Set<string>> {
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

async function collectFilesByExt(root: string, exts: string[]): Promise<string[]> {
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

async function listAllSubdirs(root: string): Promise<string[]> {
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
