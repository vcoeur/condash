/**
 * `condash templates <list|install|status>`
 *
 * Ships the body of one heading-delimited section inside selected files
 * instead of the whole file. Two templates today:
 *   - `CLAUDE.md` — `## General` (markdown H2).
 *   - `.gitignore` — `# General` (gitignore-comment style; sibling
 *     `# Specifics` terminates the region).
 * The surrounding text — anything before the General heading and the
 * user-owned `Specifics` section that follows — is never touched. Same
 * hash-based safe-update model as `condash skills install`:
 *
 *   - region matches manifest → unchanged → safe to push the new shipped region.
 *   - region differs from manifest → user edited → refuse without --force.
 *   - region present but template not in manifest → orphan → treat as edited.
 *   - heading absent or ambiguous → no region to write through; refuse without
 *     --force. With --force, write the entire shipped file (everything before
 *     `General` + `General` body + placeholder `Specifics` section).
 *   - file absent entirely → fresh install path → write the shipped file.
 *
 * The manifest entry sits alongside `skills` in
 * `<dest>/.claude/skills/.condash-skills.json`. Manifests written by older
 * condash versions used `region: "condash:general"` (the HTML-comment-marker
 * namespace); they're migrated to `region: "General"` (the heading text) on
 * the next install.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import {
  MANIFEST_VERSION,
  cheapDiff,
  readManifest,
  sha256,
  writeFileMkdir,
  writeManifest,
} from './install-shared';

interface ShippedTemplate {
  /** Path relative to dest root, e.g. "CLAUDE.md". */
  path: string;
  /** Heading text for the shipped region, e.g. "General" — matches `## General`. */
  region: string;
  /**
   * Heading prefix without trailing whitespace. Default '##' (markdown H2 —
   * used by CLAUDE.md). For gitignore-style files use '#'.
   */
  mark?: string;
  /**
   * Fixed sibling section names that end this region's body. When set, the
   * "next heading" regex matches *only* these names — required for gitignore-
   * style files where every comment line shares the mark with section
   * headings. When unset, any line starting with `mark` ends the region
   * (markdown H2 behaviour).
   */
  siblings?: string[];
}

/**
 * Hardcoded list of files condash ships partially. Adding more is a one-line
 * append plus a new entry in `conception-template/`.
 */
const SHIPPED_TEMPLATES: ShippedTemplate[] = [
  { path: 'CLAUDE.md', region: 'General' },
  { path: '.gitignore', region: 'General', mark: '#', siblings: ['Specifics'] },
];

/** Default heading mark for templates that don't specify one. Markdown H2. */
const DEFAULT_MARK = '##';

/** Options threaded into findHeading; defaults to markdown H2 with no sibling list. */
interface HeadingOpts {
  mark?: string;
  siblings?: string[];
}

function optsFor(t: ShippedTemplate): HeadingOpts {
  return { mark: t.mark ?? DEFAULT_MARK, siblings: t.siblings };
}

/**
 * Older condash versions stored the HTML-comment-marker namespace
 * (`condash:general`) as the region key. Headings replaced markers; this maps
 * the legacy value to the new heading text so an existing install reconciles
 * without a forced overwrite.
 */
function migrateLegacyRegion(region: string): string {
  if (region === 'condash:general') return 'General';
  return region;
}

export async function runTemplates(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
): Promise<void> {
  switch (verb) {
    case null:
    case 'list':
      return await listTemplates(args, ctx);
    case 'install':
      return await installTemplates(args, ctx);
    case 'status':
      return await templatesStatus(args, ctx);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown templates verb: ${verb}`);
  }
}

interface ListRow {
  path: string;
  region: string;
  installed: boolean;
  shippedVersion: string | null;
}

async function listTemplates(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const dest = await resolveDest(args).catch(() => null);
  delete args.flags.dest;
  assertNoExtraFlags(args);
  const manifest = dest ? await readManifest(dest) : null;
  const rows: ListRow[] = SHIPPED_TEMPLATES.map((t) => {
    const entry = manifest?.templates?.[t.path];
    return {
      path: t.path,
      region: t.region,
      installed: !!entry,
      shippedVersion: entry?.shippedVersion ?? null,
    };
  });
  emit(
    ctx,
    { destination: dest, templates: rows },
    (data) => {
      const d = data as { destination: string | null; templates: ListRow[] };
      const lines: string[] = [];
      if (d.destination) lines.push(`Destination: ${d.destination}`);
      for (const r of d.templates) {
        const status = r.installed ? `installed (${r.shippedVersion ?? '?'})` : 'not installed';
        lines.push(`  ${r.path.padEnd(20)} ${r.region.padEnd(20)} ${status}`);
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'templates' },
  );
}

interface InstallReport {
  destination: string;
  copied: { path: string; region: string }[];
  updated: { path: string; region: string }[];
  unchanged: { path: string; region: string }[];
  refused: { path: string; region: string; reason: string }[];
  forced: { path: string; region: string }[];
  diffs?: { path: string; region: string; diff: string }[];
}

async function installTemplates(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const requestedPaths = args.positional.length > 0 ? args.positional : null;
  const selected = requestedPaths
    ? SHIPPED_TEMPLATES.filter((t) => requestedPaths.includes(t.path))
    : SHIPPED_TEMPLATES;
  if (requestedPaths) {
    const known = new Set(SHIPPED_TEMPLATES.map((t) => t.path));
    const missing = requestedPaths.filter((p) => !known.has(p));
    if (missing.length > 0) {
      throw new CliError(ExitCodes.NOT_FOUND, `Unknown template(s): ${missing.join(', ')}`, {
        available: SHIPPED_TEMPLATES.map((t) => t.path),
      });
    }
  }

  const dest = await resolveDest(args);
  const force = args.flags.force === true;
  const showDiff = args.flags.diff === true;
  const dryRun = args.flags['dry-run'] === true;
  for (const k of ['dest', 'force', 'diff', 'dry-run']) delete args.flags[k];
  assertNoExtraFlags(args);
  const shippedVersion = process.env.CONDASH_CLI_VERSION ?? 'dev';

  const manifest = (await readManifest(dest)) ?? { version: MANIFEST_VERSION, skills: {} };
  if (!manifest.templates) manifest.templates = {};
  const templates = manifest.templates;

  const report: InstallReport = {
    destination: dest,
    copied: [],
    updated: [],
    unchanged: [],
    refused: [],
    forced: [],
    diffs: showDiff ? [] : undefined,
  };

  for (const t of selected) {
    const opts = optsFor(t);
    const sourceFullPath = join(locateShippedTemplatesRoot(), t.path);
    const sourceContent = await fs.readFile(sourceFullPath, 'utf8');
    const sourceRegion = extractRegion(sourceContent, t.region, opts);
    if (sourceRegion === null) {
      throw new CliError(
        ExitCodes.RUNTIME,
        `Shipped template ${t.path} is missing markers for region ${t.region}`,
      );
    }
    const sourceRegionHash = sha256(sourceRegion);
    const targetPath = join(dest, t.path);

    let onDisk: string | null = null;
    try {
      onDisk = await fs.readFile(targetPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // File missing entirely → fresh install: write the whole shipped file
    // (markers + placeholder specific section).
    if (onDisk === null) {
      if (!dryRun) await writeFileMkdir(targetPath, Buffer.from(sourceContent, 'utf8'));
      templates[t.path] = {
        region: t.region,
        sha256: sourceRegionHash,
        shippedVersion,
      };
      report.copied.push({ path: t.path, region: t.region });
      continue;
    }

    const onDiskRegion = extractRegion(onDisk, t.region, opts);

    // Markers absent: there's no region to update through. Without --force,
    // refuse so the user knows the file isn't being touched. With --force,
    // overwrite the whole file (same content as fresh install).
    if (onDiskRegion === null) {
      if (showDiff) {
        report.diffs!.push({
          path: t.path,
          region: t.region,
          diff: cheapDiff(onDisk, sourceContent),
        });
      }
      if (force) {
        if (!dryRun) await writeFileMkdir(targetPath, Buffer.from(sourceContent, 'utf8'));
        templates[t.path] = {
          region: t.region,
          sha256: sourceRegionHash,
          shippedVersion,
        };
        report.forced.push({ path: t.path, region: t.region });
      } else {
        report.refused.push({
          path: t.path,
          region: t.region,
          reason: `heading "${opts.mark} ${t.region}" not found (or ambiguous)`,
        });
      }
      continue;
    }

    const onDiskRegionHash = sha256(onDiskRegion);

    // Region matches shipped → already converged. Refresh manifest entry so
    // shippedVersion reflects today's run.
    if (onDiskRegionHash === sourceRegionHash) {
      report.unchanged.push({ path: t.path, region: t.region });
      templates[t.path] = {
        region: t.region,
        sha256: sourceRegionHash,
        shippedVersion,
      };
      continue;
    }

    const tracked = templates[t.path];
    const trackedRegion = tracked ? migrateLegacyRegion(tracked.region) : null;
    if (tracked && trackedRegion === t.region && tracked.sha256 === onDiskRegionHash) {
      // Region matches manifest (user hasn't edited since last install) →
      // safe to push the new shipped region.
      if (!dryRun) {
        const updated = replaceRegion(onDisk, t.region, sourceRegion, opts);
        await writeFileMkdir(targetPath, Buffer.from(updated, 'utf8'));
      }
      templates[t.path] = {
        region: t.region,
        sha256: sourceRegionHash,
        shippedVersion,
      };
      report.updated.push({ path: t.path, region: t.region });
      continue;
    }

    // Edited (or untracked-but-present). Refuse without --force.
    if (showDiff) {
      report.diffs!.push({
        path: t.path,
        region: t.region,
        diff: cheapDiff(onDiskRegion, sourceRegion),
      });
    }
    if (force) {
      if (!dryRun) {
        const updated = replaceRegion(onDisk, t.region, sourceRegion, opts);
        await writeFileMkdir(targetPath, Buffer.from(updated, 'utf8'));
      }
      templates[t.path] = {
        region: t.region,
        sha256: sourceRegionHash,
        shippedVersion,
      };
      report.forced.push({ path: t.path, region: t.region });
    } else {
      report.refused.push({
        path: t.path,
        region: t.region,
        reason: tracked ? 'edited since last install' : 'present but not tracked by manifest',
      });
    }
  }

  if (!dryRun) {
    await writeManifest(dest, manifest);
  }

  emit(ctx, report, formatInstallHuman);
  if (report.refused.length > 0 && !force) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `${report.refused.length} template(s) refused. Re-run with --force to overwrite or --diff to inspect.`,
      { refused: report.refused },
    );
  }
}

function formatInstallHuman(report: InstallReport): string {
  const lines: string[] = [];
  lines.push(`Destination: ${report.destination}`);
  if (report.copied.length > 0) {
    lines.push(`Copied (${report.copied.length}):`);
    for (const f of report.copied) lines.push(`  + ${f.path}  (${f.region})`);
  }
  if (report.updated.length > 0) {
    lines.push(`Updated (${report.updated.length}):`);
    for (const f of report.updated) lines.push(`  ↻ ${f.path}  (${f.region})`);
  }
  if (report.unchanged.length > 0) {
    lines.push(`Unchanged: ${report.unchanged.length}`);
  }
  if (report.forced.length > 0) {
    lines.push(`Forced overwrite (${report.forced.length}):`);
    for (const f of report.forced) lines.push(`  ! ${f.path}  (${f.region})`);
  }
  if (report.refused.length > 0) {
    lines.push(`Refused (${report.refused.length}):`);
    for (const f of report.refused) {
      lines.push(`  × ${f.path}  (${f.reason})`);
    }
  }
  if (report.diffs && report.diffs.length > 0) {
    for (const d of report.diffs) {
      lines.push('');
      lines.push(`--- diff: ${d.path}  (${d.region})`);
      lines.push(d.diff);
    }
  }
  return lines.join('\n') + '\n';
}

interface StatusRow {
  path: string;
  region: string;
  state: 'unchanged' | 'edited' | 'missing' | 'missing-heading' | 'orphan' | 'outdated';
  shippedVersion: string | null;
}

async function templatesStatus(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const dest = await resolveDest(args);
  delete args.flags.dest;
  assertNoExtraFlags(args);
  const manifest = (await readManifest(dest)) ?? { version: MANIFEST_VERSION, skills: {} };
  const templates = manifest.templates ?? {};

  const rows: StatusRow[] = [];
  for (const t of SHIPPED_TEMPLATES) {
    const opts = optsFor(t);
    const entry = templates[t.path];
    const targetPath = join(dest, t.path);
    let onDisk: string | null = null;
    try {
      onDisk = await fs.readFile(targetPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (onDisk === null) {
      // File missing. Distinguishes orphan-manifest (entry but no file) from
      // simply not-installed-yet.
      if (entry) {
        rows.push({
          path: t.path,
          region: t.region,
          state: 'missing',
          shippedVersion: entry.shippedVersion,
        });
      }
      continue;
    }
    const onDiskRegion = extractRegion(onDisk, t.region, opts);
    if (onDiskRegion === null) {
      rows.push({
        path: t.path,
        region: t.region,
        state: 'missing-heading',
        shippedVersion: entry?.shippedVersion ?? null,
      });
      continue;
    }
    const onDiskHash = sha256(onDiskRegion);
    if (!entry) {
      rows.push({ path: t.path, region: t.region, state: 'orphan', shippedVersion: null });
      continue;
    }
    if (onDiskHash !== entry.sha256) {
      rows.push({
        path: t.path,
        region: t.region,
        state: 'edited',
        shippedVersion: entry.shippedVersion,
      });
      continue;
    }
    // On disk matches manifest. Compare to currently-shipped to detect updates.
    const sourcePath = join(locateShippedTemplatesRoot(), t.path);
    let sourceRegion: string | null = null;
    try {
      const sourceContent = await fs.readFile(sourcePath, 'utf8');
      sourceRegion = extractRegion(sourceContent, t.region, opts);
    } catch {
      /* fall through */
    }
    if (sourceRegion !== null && sha256(sourceRegion) !== entry.sha256) {
      rows.push({
        path: t.path,
        region: t.region,
        state: 'outdated',
        shippedVersion: entry.shippedVersion,
      });
    } else {
      rows.push({
        path: t.path,
        region: t.region,
        state: 'unchanged',
        shippedVersion: entry.shippedVersion,
      });
    }
  }

  // Orphan-manifest rows: entries in the manifest that don't correspond to a
  // currently-shipped template. Surface them so users can clean up.
  const shippedSet = new Set(SHIPPED_TEMPLATES.map((t) => t.path));
  for (const [path, entry] of Object.entries(templates)) {
    if (shippedSet.has(path)) continue;
    rows.push({
      path,
      region: migrateLegacyRegion(entry.region),
      state: 'orphan',
      shippedVersion: entry.shippedVersion,
    });
  }

  emit(
    ctx,
    { destination: dest, items: rows },
    (data) => {
      const d = data as { destination: string; items: StatusRow[] };
      if (d.items.length === 0) return `(no templates tracked under ${d.destination})\n`;
      const widths = {
        path: Math.max(4, ...d.items.map((r) => r.path.length)),
        region: Math.max(6, ...d.items.map((r) => r.region.length)),
        state: 16,
      };
      return (
        d.items
          .map(
            (r) =>
              `  ${r.path.padEnd(widths.path)}  ${r.region.padEnd(widths.region)}  ${r.state.padEnd(widths.state)}  ${r.shippedVersion ?? '-'}`,
          )
          .join('\n') + '\n'
      );
    },
    [],
    { streamField: 'items' },
  );
}

async function resolveDest(args: ParsedArgs): Promise<string> {
  const explicit = args.flags.dest;
  if (typeof explicit === 'string') {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  }
  try {
    const resolved = await resolveConception(undefined);
    return resolved.path;
  } catch {
    return process.cwd();
  }
}

function locateShippedTemplatesRoot(): string {
  // Same resolution as skills: override hatch primarily for tests, then walk
  // up from the bundled CLI to find conception-template/.
  const override = process.env.CONDASH_TEMPLATE_ROOT;
  if (override) return override;
  return join(__dirname, '..', 'conception-template');
}

/**
 * Extract the body of a section identified by its heading text.
 *
 * Default (no `opts`) is markdown H2: region body is everything between
 * `## <region>` (exclusive) and the next `## …` (exclusive) or end-of-file.
 *
 * With `opts.mark = '#'` and `opts.siblings = [...]`, parses gitignore-style
 * sections: region body runs between `# <region>` and the next line matching
 * `# <one-of-siblings>` (exclusive) or end-of-file. The fixed sibling list
 * is required because every gitignore comment line starts with `#` — a
 * generic "any heading at this level" stop would match user comments.
 *
 * The heading line itself and any trailing blank line before the next
 * heading are not part of the body — they are structural and would otherwise
 * leak into the hash.
 *
 * Returns `null` when the heading is missing or appears more than once
 * (ambiguous) — both cases are treated as `missing-heading` upstream so the
 * user is asked rather than silently overwritten.
 *
 * The match is case- and whitespace-sensitive on the heading text itself.
 * For markdown mode, H3+ (`### …`) never match: the regex demands exactly
 * two `#`.
 */
export function extractRegion(
  content: string,
  region: string,
  opts: HeadingOpts = {},
): string | null {
  const heading = findHeading(content, region, opts);
  if (heading === null) return null;
  return content.slice(heading.bodyStart, heading.bodyEnd);
}

/**
 * Replace the body of the section identified by `region`, preserving the
 * heading line and everything outside the region. Throws when the heading is
 * missing or ambiguous; callers should use `extractRegion` first to gate.
 */
export function replaceRegion(
  content: string,
  region: string,
  replacement: string,
  opts: HeadingOpts = {},
): string {
  const heading = findHeading(content, region, opts);
  if (heading === null) {
    throw new Error(`Region ${region} not found in content`);
  }
  const before = content.slice(0, heading.bodyStart);
  const after = content.slice(heading.tailStart);
  if (after.length === 0) {
    // Heading runs to EOF — trail the new body with one newline so the file
    // ends cleanly.
    return `${before}${replacement}\n`;
  }
  // A blank line separates the body from the next heading. We always emit
  // one, normalising whatever the user had before.
  return `${before}${replacement}\n\n${after}`;
}

interface HeadingSpan {
  /** Index of the first byte of the body content (after the heading line). */
  bodyStart: number;
  /** Index of the last byte + 1 of the body content (after trimming the
   *  trailing newlines that separate body from next heading or EOF). Used
   *  for hashing and extraction. */
  bodyEnd: number;
  /** Index of the start of the tail region — i.e. the next sibling heading
   *  or EOF. Used by `replaceRegion` so the trailing newlines don't get
   *  duplicated. */
  tailStart: number;
}

function findHeading(content: string, region: string, opts: HeadingOpts): HeadingSpan | null {
  const mark = opts.mark ?? DEFAULT_MARK;
  const headingRe = new RegExp(`^${escapeRegex(mark)}[ \\t]+${escapeRegex(region)}[ \\t]*$`, 'gm');
  const matches = [...content.matchAll(headingRe)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const headingStart = match.index!;
  const headingEnd = headingStart + match[0].length;
  // Body starts on the line after the heading; skip exactly one '\n'.
  let bodyStart = headingEnd;
  if (content[bodyStart] === '\n') bodyStart += 1;

  // Next-heading regex. With siblings, match only those names — the fixed
  // list is what makes gitignore parsing safe (every comment shares `#`).
  // Without siblings, fall back to the markdown lookahead: any line starting
  // with the mark followed by space/tab is a sibling heading (H3+ excluded
  // because the lookahead demands whitespace immediately after the mark).
  const nextRe = opts.siblings
    ? new RegExp(
        `^${escapeRegex(mark)}[ \\t]+(?:${opts.siblings.map(escapeRegex).join('|')})[ \\t]*$`,
        'gm',
      )
    : new RegExp(`^${escapeRegex(mark)}(?=[ \\t])`, 'gm');
  nextRe.lastIndex = bodyStart;
  const next = nextRe.exec(content);
  const tailStart = next ? next.index : content.length;
  // Trim trailing newlines so the hash is stable when the user adds or
  // removes blank lines before the next heading.
  let bodyEnd = tailStart;
  while (bodyEnd > bodyStart && content[bodyEnd - 1] === '\n') bodyEnd -= 1;
  return { bodyStart, bodyEnd, tailStart };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
