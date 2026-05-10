/**
 * `index` audit check — every directory under `knowledge/` carries an
 * `index.md` listing its children. Flags missing index files, dangling
 * links pointing at non-existent files, and orphan body files that no
 * parent index references.
 */

import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathExists } from '../fs-helpers';
import { type AuditIssue, listAllSubdirs } from './shared';

export async function checkIndex(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const knowledgeRoot = join(conceptionPath, 'knowledge');
  if (!(await pathExists(knowledgeRoot))) {
    issues.push({
      check: 'index',
      severity: 'error',
      file: 'knowledge/',
      line: null,
      message: 'knowledge/ directory missing',
      fix: { action: 'create_knowledge_dir', autoFix: false },
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
        message: `Directory has no index.md — run condash-cli knowledge index`,
        fix: { action: 'run_knowledge_index', autoFix: true },
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
          fix: { action: 'remove_index_line', autoFix: true, path: rawLink, label: m[1] },
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
          message: `Body file not referenced from ${relative(conceptionPath, d)}/index.md — run condash-cli knowledge index`,
          fix: { action: 'run_knowledge_index', autoFix: true, path: rel },
        });
      }
    }
  }
  return issues;
}
