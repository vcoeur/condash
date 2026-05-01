import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isItemFolderName } from './slug';

const META_LINE = /^\*\*([A-Za-z][\w -]*)\*\*\s*:\s*(.+?)\s*$/;
const HEADING2 = /^##\s+(.+)$/;
const BACKTICK = /`([^`]+)`/g;

const KNOWN_STATUSES = ['now', 'review', 'later', 'backlog', 'done'];
const KNOWN_KINDS = ['project', 'incident', 'document'];

export interface HeaderFields {
  /** Raw H1 (the line starting with `# `), without the leading hashes. */
  title: string | null;
  date: string | null;
  status: string | null;
  kind: string | null;
  apps: string[];
  /** Auth value from `**Branch**: \`<name>\` …`. The first backticked token
   *  is authoritative per `projects/SKILL.md` — trailing prose is ignored. */
  branch: string | null;
  base: string | null;
  /** Anything else surfaced under `**Key**` we didn't break out by name —
   *  preserves Environment / Severity / Verified / etc. */
  extra: Record<string, string>;
}

export interface HeaderValidation {
  errors: HeaderIssue[];
  warnings: HeaderIssue[];
}

export interface HeaderIssue {
  field: string;
  message: string;
}

/** Read + parse the header block of an item README. */
export async function readHeader(readmePath: string): Promise<HeaderFields> {
  const raw = await fs.readFile(readmePath, 'utf8');
  return parseHeader(raw);
}

export function parseHeader(raw: string): HeaderFields {
  const lines = raw.split(/\r?\n/);
  const meta = new Map<string, string>();
  let title: string | null = null;
  let pastTitle = false;

  for (const line of lines) {
    if (HEADING2.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!pastTitle) {
      if (trimmed.startsWith('#')) {
        title = trimmed.replace(/^#+\s*/, '').trim() || null;
      }
      pastTitle = true;
      continue;
    }
    const m = trimmed.match(META_LINE);
    if (m) meta.set(m[1].toLowerCase(), m[2]);
  }

  const apps = extractBackticked(meta.get('apps') ?? '');
  const branch = extractBackticked(meta.get('branch') ?? '')[0] ?? null;
  const base = extractBackticked(meta.get('base') ?? '')[0] ?? null;

  const extra: Record<string, string> = {};
  for (const [k, v] of meta) {
    if (['date', 'status', 'kind', 'apps', 'branch', 'base'].includes(k)) continue;
    extra[k] = v;
  }

  return {
    title,
    date: meta.get('date')?.trim() ?? null,
    status: meta.get('status')?.trim().toLowerCase() ?? null,
    kind: meta.get('kind')?.trim().toLowerCase() ?? null,
    apps,
    branch,
    base,
    extra,
  };
}

function extractBackticked(value: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  BACKTICK.lastIndex = 0;
  while ((m = BACKTICK.exec(value))) {
    out.push(m[1].trim());
  }
  return out;
}

/**
 * Validate a parsed header against the canonical enums + the slug regex on
 * the parent folder. Errors are exit-3-worthy (Status/Kind enum miss, regex
 * miss); warnings are surfaced but never fail the call (missing required
 * field, date drift).
 */
export function validateHeader(fields: HeaderFields, readmePath: string): HeaderValidation {
  const errors: HeaderIssue[] = [];
  const warnings: HeaderIssue[] = [];

  const folderName = basename(dirname(readmePath));
  if (!isItemFolderName(folderName)) {
    errors.push({
      field: 'folder',
      message: `Folder name '${folderName}' does not match ^\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]+$`,
    });
  }

  if (!fields.status) {
    warnings.push({ field: 'status', message: 'Missing **Status**' });
  } else if (!KNOWN_STATUSES.includes(fields.status)) {
    errors.push({
      field: 'status',
      message: `Status '${fields.status}' not in {${KNOWN_STATUSES.join(', ')}}`,
    });
  }

  if (!fields.kind) {
    warnings.push({ field: 'kind', message: 'Missing **Kind**' });
  } else if (!KNOWN_KINDS.includes(fields.kind)) {
    errors.push({
      field: 'kind',
      message: `Kind '${fields.kind}' not in {${KNOWN_KINDS.join(', ')}}`,
    });
  }

  if (!fields.date) {
    warnings.push({ field: 'date', message: 'Missing **Date**' });
  } else if (folderName.startsWith(fields.date)) {
    // ok
  } else {
    const folderPrefix = folderName.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (folderPrefix && folderPrefix !== fields.date) {
      errors.push({
        field: 'date',
        message: `Header **Date** ${fields.date} does not match folder prefix ${folderPrefix}`,
      });
    } else {
      warnings.push({
        field: 'date',
        message: `**Date** ${fields.date} could not be cross-checked against folder name`,
      });
    }
  }

  if (!fields.apps.length) {
    warnings.push({ field: 'apps', message: '**Apps** is empty or missing' });
  }

  return { errors, warnings };
}

export const ENUMS = {
  KNOWN_STATUSES,
  KNOWN_KINDS,
} as const;
