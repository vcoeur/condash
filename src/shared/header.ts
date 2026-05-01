/**
 * Pure parsing of item README headers (the H1 + `**Key**: value` block above
 * the first `## ` heading) and the canonical enums + folder-slug regex used
 * to validate them. Lives in `shared/` so both the Electron main process and
 * the CLI can consume it without crossing module layers — historically this
 * code lived in `cli/header.ts` and `main/parse.ts`, and the duplication
 * leaked through as `main → cli` imports plus drifting regexes.
 *
 * Anything that touches the filesystem (e.g. `readHeader`) stays out of this
 * module. Callers that need to validate folder names by path pass the path
 * in; we do not import `node:fs` here.
 */
import { KNOWN_STATUSES } from './types';

export const META_LINE = /^\*\*([A-Za-z][\w -]*)\*\*\s*:\s*(.+?)\s*$/;
export const HEADING2 = /^##\s+(.+)$/;
const BACKTICK = /`([^`]+)`/g;

export const KNOWN_KINDS = ['project', 'incident', 'document'] as const;

export const ENUMS = {
  KNOWN_STATUSES,
  KNOWN_KINDS,
} as const;

const FOLDER_NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;

export function isItemFolderName(name: string): boolean {
  return FOLDER_NAME_RE.test(name);
}

export function itemFolderRegex(): RegExp {
  return FOLDER_NAME_RE;
}

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

/** Last directory segment of a README path — `parentFolderName('a/b/c/README.md')`
 *  is `'c'`. Implemented in pure string ops so this module can stay free of
 *  `node:path` (the renderer transitively imports `KNOWN_STATUSES` from
 *  `shared/types`, and pulling `node:path` into shared breaks that build). */
function parentFolderName(readmePath: string): string {
  const parts = readmePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
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

  const folderName = parentFolderName(readmePath);
  if (!isItemFolderName(folderName)) {
    errors.push({
      field: 'folder',
      message: `Folder name '${folderName}' does not match ^\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]+$`,
    });
  }

  if (!fields.status) {
    warnings.push({ field: 'status', message: 'Missing **Status**' });
  } else if (!(KNOWN_STATUSES as readonly string[]).includes(fields.status)) {
    errors.push({
      field: 'status',
      message: `Status '${fields.status}' not in {${KNOWN_STATUSES.join(', ')}}`,
    });
  }

  if (!fields.kind) {
    warnings.push({ field: 'kind', message: 'Missing **Kind**' });
  } else if (!(KNOWN_KINDS as readonly string[]).includes(fields.kind)) {
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
