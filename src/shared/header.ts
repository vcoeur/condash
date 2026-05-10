/**
 * Pure parsing of item README headers and the canonical enums + folder-slug
 * regex used to validate them. Two header shapes are accepted:
 *
 *   1. **YAML frontmatter** (canonical, emitted by `renderTemplate` from
 *      v2.16.0 onward): a `---`-delimited block at the top of the file with
 *      `key: value` pairs (`apps:` is a YAML sequence). The H1 follows the
 *      closing `---`.
 *   2. **Bold-prose** (legacy, accepted indefinitely): `# Title` followed by
 *      `**Key**: value` lines until the first `## ` heading. Backticked tokens
 *      inside `**Apps**` / `**Branch**` / `**Base**` are extracted as values.
 *
 * Both shapes feed the same `HeaderFields` output. `rewriteHeaderToYaml`
 * (in `main/rewrite-headers.ts`) converts shape 2 → shape 1.
 *
 * Lives in `shared/` so both the Electron main process and the CLI can
 * consume it without crossing module layers. Anything that touches the
 * filesystem (e.g. `readHeader`) stays out of this module.
 */
import { parse as parseYaml } from 'yaml';
import { KNOWN_STATUSES } from './types';

export const META_LINE = /^\*\*([A-Za-z][\w -]*)\*\*\s*:\s*(.+?)\s*$/;
export const HEADING2 = /^##\s+(.+)$/;
const BACKTICK = /`([^`]+)`/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export const KNOWN_KINDS = ['project', 'incident', 'document'] as const;

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
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (fmMatch) {
    return parseYamlFrontmatterHeader(fmMatch[1], raw.slice(fmMatch[0].length));
  }
  return parseBoldProseHeader(raw);
}

function parseBoldProseHeader(raw: string): HeaderFields {
  const lines = raw.split(/\r?\n/);
  const meta = new Map<string, string>();
  let title: string | null = null;
  let pastTitle = false;
  let metaStarted = false;

  for (const line of lines) {
    if (HEADING2.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed) {
      // Blank line: tolerate inside the H1 → meta gap; once meta has started,
      // the next blank ends the header. This stops a stray paragraph after
      // the meta block from leaking into `extra`.
      if (metaStarted) break;
      continue;
    }
    if (!pastTitle) {
      if (trimmed.startsWith('#')) {
        title = trimmed.replace(/^#+\s*/, '').trim() || null;
      }
      pastTitle = true;
      continue;
    }
    const m = trimmed.match(META_LINE);
    if (m) {
      meta.set(m[1].toLowerCase(), m[2]);
      metaStarted = true;
      continue;
    }
    // Past the title and not a meta line: if we already saw meta, we're done;
    // otherwise tolerate (e.g. a TOC paragraph before the meta block).
    if (metaStarted) break;
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

/**
 * Map a parsed YAML frontmatter object onto `HeaderFields`. Permissive about
 * shape — invalid YAML, non-object roots, and unknown keys all degrade to
 * empty/null rather than throwing, so a malformed header doesn't crash the
 * dashboard. Validation of values (enum membership, folder-name cross-check)
 * happens later in `validateHeader`.
 *
 * The body following the frontmatter is scanned for the first H1 to populate
 * `title`. Falls back to `null` when the body has no `#`-prefixed line.
 *
 * Severity in YAML lives in two fields (`severity` enum + `severity_impact`
 * free text) but legacy consumers read `extra.severity` as a single string.
 * We compose `<severity> — <severity_impact>` into `extra.severity` for
 * compatibility, while keeping the split fields available individually.
 */
function parseYamlFrontmatterHeader(yamlBody: string, body: string): HeaderFields {
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(yamlBody);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — degrade silently. validateHeader will surface the
    // missing fields downstream.
  }

  let title: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      title = trimmed.replace(/^#+\s*/, '').trim() || null;
    }
    break;
  }

  const apps = normaliseAppsValue(data.apps);
  const branch = scalarToString(data.branch);
  const base = scalarToString(data.base);
  const date = scalarToString(data.date);
  const status = scalarToString(data.status)?.toLowerCase() ?? null;
  const kind = scalarToString(data.kind)?.toLowerCase() ?? null;

  const KNOWN = new Set(['date', 'kind', 'status', 'apps', 'branch', 'base']);
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (KNOWN.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      extra[key] = value.map((v) => String(v)).join(', ');
    } else if (typeof value === 'object') {
      extra[key] = JSON.stringify(value);
    } else {
      extra[key] = String(value);
    }
  }
  // Legacy compatibility: bold-prose stored severity as `<level> — <impact>`
  // in a single line; split fields recombine for any consumer reading
  // `extra.severity` as a string.
  if ('severity' in extra && 'severity_impact' in extra) {
    const sev = extra.severity;
    const impact = extra.severity_impact;
    if (sev && impact) extra.severity = `${sev} — ${impact}`;
  }

  return { title, date, status, kind, apps, branch, base, extra };
}

function scalarToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  return text || null;
}

function normaliseAppsValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((s) => s.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim().replace(/^`|`$/g, ''))
      .filter((s) => s.length > 0);
  }
  return [];
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

const STEPS_HEADING = /^##\s+Steps\s*$/i;
const FENCE = /^\s*```/;
const WIKILINK = /\[\[[^\]]+\]\]/;
const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/;

/**
 * Lint the body of a README for rules that must hold beyond the header block.
 *
 * Currently enforces the **Steps-must-be-link-free** rule from
 * `projects/SKILL.md`: any `[[…]]` wikilink or `[label](path)` markdown link
 * inside the `## Steps` section is surfaced as a warning. The Projects-tab
 * card renderer prints step lines verbatim, and links wrap as raw text there.
 *
 * Fenced code blocks inside `## Steps` are skipped — a backticked or fenced
 * snippet that happens to contain link-shaped characters is fine.
 */
export function validateBody(raw: string): HeaderValidation {
  const errors: HeaderIssue[] = [];
  const warnings: HeaderIssue[] = [];
  const lines = raw.split(/\r?\n/);
  let inSteps = false;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (STEPS_HEADING.test(line)) {
      inSteps = true;
      continue;
    }
    if (inSteps && HEADING2.test(line)) {
      inSteps = false;
      continue;
    }
    if (!inSteps) continue;
    if (WIKILINK.test(line)) {
      warnings.push({
        field: 'steps',
        message: `line ${i + 1}: wikilink [[…]] inside ## Steps — move it to ## Step details or ## Notes (the Projects-tab card renders step lines verbatim and links wrap as raw text)`,
      });
    } else if (MD_LINK.test(line)) {
      warnings.push({
        field: 'steps',
        message: `line ${i + 1}: markdown link [label](path) inside ## Steps — move it to ## Step details or ## Notes (the Projects-tab card renders step lines verbatim and links wrap as raw text)`,
      });
    }
  }
  return { errors, warnings };
}
