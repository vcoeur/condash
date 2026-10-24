/**
 * `cross-repo` audit check — sibling-app agent-instruction files
 * (`AGENTS.md` / `CLAUDE.md` / `.claude/CLAUDE.md`) whose references
 * dot-walk into the conception tree (`../conception/...`) but no
 * longer resolve.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathExists } from '../fs-helpers';
import { type AuditIssue, SKIP_SCAN_DIRS, readConfig } from './shared';

export async function checkCrossRepo(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const config = await readConfig(conceptionPath);
  const workspace = config.workspace_path;
  if (!workspace) return issues;
  const apps = await listSiblingApps(workspace, conceptionPath);
  const refRe = /\(((?:\.\.\/)+conception\/[^)\s]+)\)/g;
  for (const instructionPath of apps) {
    let raw: string;
    try {
      raw = await fs.readFile(instructionPath, 'utf8');
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    refRe.lastIndex = 0;
    while ((match = refRe.exec(raw))) {
      const ref = match[1];
      const target = resolve(dirname(instructionPath), ref);
      const exists = await pathExists(target);
      if (exists) continue;
      const lineNo = raw.slice(0, match.index).split('\n').length;
      issues.push({
        check: 'cross-repo',
        severity: 'warn',
        file: instructionPath,
        line: lineNo,
        message: `Reference to ${ref} does not resolve`,
        fix: { action: 'flag_for_user_edit', autoFix: false, ref, inFile: instructionPath },
      });
    }
  }
  return issues;
}

/** Instruction-file candidates per repo checkout, canonical-first — the same
 *  order as `INSTRUCTION_FILES` in `../applications.ts`. Every candidate that
 *  exists is scanned; a legacy repo carrying both AGENTS.md and CLAUDE.md
 *  yields distinct paths, so findings can never duplicate. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', join('.claude', 'CLAUDE.md')];

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
    for (const sub of INSTRUCTION_FILES) {
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
      for (const sub of INSTRUCTION_FILES) {
        const candidate = join(innerDir, sub);
        if (await pathExists(candidate)) out.push(candidate);
      }
    }
  }
  return out;
}
