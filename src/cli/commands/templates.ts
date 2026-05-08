/**
 * `condash templates <list|install|status>`
 *
 * Ships the marker-delimited *region* of selected files instead of the
 * whole file. Today this is just `CLAUDE.md` with the
 * `<!-- condash:general:begin -->` … `<!-- condash:general:end -->` region;
 * the surrounding text (notably the user-owned `## Specific to this
 * conception` section) is never touched. Same hash-based safe-update model
 * as `condash skills install`:
 *
 *   - region matches manifest → unchanged → safe to push the new shipped region.
 *   - region differs from manifest → user edited → refuse without --force.
 *   - region present but template not in manifest → orphan → treat as edited.
 *   - markers absent → no region to write through; refuse without --force.
 *     With --force, write the entire shipped file (markers + placeholder
 *     `## Specific to this conception` section), creating both halves.
 *   - file absent entirely → fresh install path → write the shipped file.
 *
 * The manifest entry sits alongside `skills` in
 * `<dest>/.claude/skills/.condash-skills.json`.
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
  /** Marker name, e.g. "condash:general". */
  region: string;
}

/**
 * Hardcoded list of files condash ships partially. Today there's only one;
 * adding more (e.g. another top-level marker-delimited file) is a one-line
 * append plus a new entry in `conception-template/`.
 */
const SHIPPED_TEMPLATES: ShippedTemplate[] = [{ path: 'CLAUDE.md', region: 'condash:general' }];

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
    const sourceFullPath = join(locateShippedTemplatesRoot(), t.path);
    const sourceContent = await fs.readFile(sourceFullPath, 'utf8');
    const sourceRegion = extractRegion(sourceContent, t.region);
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

    const onDiskRegion = extractRegion(onDisk, t.region);

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
          reason: `markers <!-- ${t.region}:begin/end --> not found`,
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
    if (tracked && tracked.region === t.region && tracked.sha256 === onDiskRegionHash) {
      // Region matches manifest (user hasn't edited since last install) →
      // safe to push the new shipped region.
      if (!dryRun) {
        const updated = replaceRegion(onDisk, t.region, sourceRegion);
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
        const updated = replaceRegion(onDisk, t.region, sourceRegion);
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
  state: 'unchanged' | 'edited' | 'missing' | 'missing-markers' | 'orphan' | 'outdated';
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
    const onDiskRegion = extractRegion(onDisk, t.region);
    if (onDiskRegion === null) {
      rows.push({
        path: t.path,
        region: t.region,
        state: 'missing-markers',
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
      sourceRegion = extractRegion(sourceContent, t.region);
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
      region: entry.region,
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
 * Extract the content between `<!-- <region>:begin -->` and
 * `<!-- <region>:end -->` markers, exclusive of the marker lines.
 *
 * Returns `null` if either marker is missing or `:end` precedes `:begin`.
 * Both markers must each be on their own line; surrounding whitespace and
 * other line content is rejected so a malformed (or only partially commented)
 * marker doesn't accidentally match.
 *
 * The trailing newline after the begin marker and before the end marker is
 * NOT part of the region content. Callers that hash the region get a stable
 * hash regardless of line-ending style as long as the region content itself
 * is normalised.
 */
export function extractRegion(content: string, region: string): string | null {
  const beginRe = new RegExp(`^<!--\\s*${escapeRegex(region)}:begin\\s*-->\\s*$`, 'm');
  const endRe = new RegExp(`^<!--\\s*${escapeRegex(region)}:end\\s*-->\\s*$`, 'm');
  const beginMatch = beginRe.exec(content);
  if (!beginMatch) return null;
  const endMatch = endRe.exec(content);
  if (!endMatch) return null;
  const beginEndIdx = beginMatch.index + beginMatch[0].length;
  if (endMatch.index <= beginEndIdx) return null;
  // Trim the single newline that immediately follows the begin marker and
  // the one immediately preceding the end marker — they're structural and
  // would otherwise leak into the hash.
  let start = beginEndIdx;
  if (content[start] === '\n') start += 1;
  let end = endMatch.index;
  if (end > 0 && content[end - 1] === '\n') end -= 1;
  if (end < start) return '';
  return content.slice(start, end);
}

/**
 * Replace the content between markers with `replacement`, preserving the
 * marker lines verbatim. Caller is responsible for ensuring the region
 * exists (use `extractRegion` first).
 */
export function replaceRegion(content: string, region: string, replacement: string): string {
  const beginRe = new RegExp(`^<!--\\s*${escapeRegex(region)}:begin\\s*-->\\s*$`, 'm');
  const endRe = new RegExp(`^<!--\\s*${escapeRegex(region)}:end\\s*-->\\s*$`, 'm');
  const beginMatch = beginRe.exec(content);
  const endMatch = endRe.exec(content);
  if (!beginMatch || !endMatch) {
    throw new Error(`Region ${region} not found in content`);
  }
  const beginEnd = beginMatch.index + beginMatch[0].length;
  const before = content.slice(0, beginEnd);
  const after = content.slice(endMatch.index);
  // Re-introduce the structural newlines around the new region content.
  return `${before}\n${replacement}\n${after}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
