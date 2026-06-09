/**
 * Projects tree drafting strategy for the index regenerator.
 *
 * The two layers in `projects/` look different:
 *
 *  - Root (`projects/index.md`): bullets one per month dir
 *      `- [\`2026-04/\`](2026-04/index.md) — *aggregate.* \`[…]\``
 *  - Month (`projects/YYYY-MM/index.md`): bullets one per item folder
 *      `- [\`<slug>/\`](<slug>/README.md) — *description.* \`[kind, status, …]\``
 *
 * Item folders carry a `README.md`, not an `index.md`, so the engine asks
 * this strategy how to format the link target and which file to lift content
 * from.
 *
 * Pre-pass validation runs `validateHeader` over every item README, surfacing
 * Status/Kind enum drift, Date↔folder drift, and missing Apps as warnings.
 * The skill displays them; the engine never writes to a README.
 */

import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { findProjectReadmes } from './walk';
import { iterUnfencedLines, parseHeader, validateHeader } from '../shared/header';
import { appHandle } from '../shared/app-color';
import type { ChildInfo, DraftResult, IndexStrategy, ValidationWarning } from './index-tree';

const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
const ITEM_DIR_RE = /^\d{4}-\d{2}-\d{2}-/;

export const projectsStrategy: IndexStrategy = {
  treeName: 'projects',
  rootDirName: 'projects',
  formatChildLink: (parent, child) => {
    if (child.kind !== 'directory') return child.name;
    const parentName = basename(parent);
    if (MONTH_DIR_RE.test(parentName) && ITEM_DIR_RE.test(child.name)) {
      return `${child.name}/README.md`;
    }
    return `${child.name}/index.md`;
  },
  draftFileEntry: async (_parent, child): Promise<DraftResult> => {
    // No file entries expected at projects/ or projects/YYYY-MM/ — both layers
    // are dir-only. If one slips through, surface a placeholder.
    return {
      description: `(unexpected file ${child.name})`,
      keywords: ['unexpected'],
    };
  },
  draftSubdirEntry: async (parent, child, aggregated): Promise<DraftResult> => {
    const parentName = basename(parent);

    if (MONTH_DIR_RE.test(parentName) && ITEM_DIR_RE.test(child.name)) {
      return draftItemEntry(child);
    }
    if (parentName === 'projects' && MONTH_DIR_RE.test(child.name)) {
      return draftMonthEntry(child, aggregated);
    }
    return {
      description: `(describe ${child.name}/)`,
      keywords: aggregated.slice(0, 8),
    };
  },
  preValidation: validateAllReadmes,
  initialTemplate: (relPath) => {
    if (relPath === '.') {
      return [
        `# Projects`,
        ``,
        `One folder per item at \`projects/YYYY-MM/YYYY-MM-DD-slug/\`. Items never move once created.`,
        ``,
        `## Months`,
        ``,
      ].join('\n');
    }
    if (MONTH_DIR_RE.test(basename(relPath))) {
      return [
        `# ${basename(relPath)}`,
        ``,
        `Items created in ${basename(relPath)}.`,
        ``,
        `## Items`,
        ``,
      ].join('\n');
    }
    return [`# ${basename(relPath)}`, '', `(describe ${relPath}/)`, ''].join('\n');
  },
};

async function draftItemEntry(child: ChildInfo): Promise<DraftResult> {
  const readme = join(child.absPath, 'README.md');
  let raw: string;
  try {
    raw = await fs.readFile(readme, 'utf8');
  } catch {
    return {
      description: `(README.md missing in ${child.name})`,
      keywords: ['missing-readme'],
    };
  }
  const header = parseHeader(raw);
  const summary = extractFirstProse(raw);
  // Kind + status always lead the tag list, then app slugs.
  const tags: string[] = [];
  if (header.kind) tags.push(header.kind);
  if (header.status) tags.push(header.status);
  for (const app of header.apps) {
    const slug = appHandle(app);
    if (slug && !tags.includes(slug)) tags.push(slug);
  }
  if (tags.length === 0) tags.push('item');
  const desc =
    summary && summary.length > 10
      ? clip(summary, 200)
      : header.title
        ? header.title
        : `(describe ${child.name})`;
  return {
    description: clip(desc, 200),
    keywords: tags.slice(0, 8),
  };
}

async function draftMonthEntry(child: ChildInfo, aggregated: string[]): Promise<DraftResult> {
  const indexPath = join(child.absPath, 'index.md');
  let raw = '';
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch {
    // Engine processes leaves first, so this should be rare. Fall back.
  }
  const summary = extractFirstProse(raw) ?? `Items created in ${child.name}.`;
  return {
    description: clip(summary, 200),
    keywords: aggregated.slice(0, 8),
  };
}

async function validateAllReadmes(
  _rootAbsPath: string,
  conceptionPath: string,
): Promise<ValidationWarning[]> {
  const out: ValidationWarning[] = [];
  const readmes = await findProjectReadmes(conceptionPath);
  for (const readme of readmes) {
    const raw = await fs.readFile(readme, 'utf8').catch(() => '');
    if (!raw) continue;
    const fields = parseHeader(raw);
    const v = validateHeader(fields, readme);
    for (const e of v.errors) {
      out.push({ path: readme, field: e.field, message: e.message, severity: 'error' });
    }
    for (const w of v.warnings) {
      out.push({ path: readme, field: w.field, message: w.message, severity: 'warn' });
    }
  }
  return out;
}

function extractFirstProse(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  let pastTitle = false;
  let pastMeta = false;
  const buffer: string[] = [];
  // `iterUnfencedLines` owns the fence tracking (``` and ~~~, with the
  // CommonMark matching-marker close rule).
  for (const { line: r } of iterUnfencedLines(lines)) {
    const line = r.trim();
    if (!pastTitle) {
      if (line.startsWith('#')) {
        pastTitle = true;
      }
      continue;
    }
    // Skip the metadata block (lines starting with **Key**:) and any heading.
    if (/^\*\*[A-Z][^*]+\*\*\s*:/.test(line)) {
      pastMeta = true;
      continue;
    }
    if (line.startsWith('#')) {
      if (buffer.length > 0) break;
      pastMeta = true;
      continue;
    }
    if (line === '') {
      if (buffer.length > 0) break;
      continue;
    }
    if (/^(-\s|\*\s|>\s?|\|)/.test(line)) continue;
    if (!pastMeta) continue;
    buffer.push(line);
  }
  if (buffer.length === 0) return undefined;
  return buffer
    .join(' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
