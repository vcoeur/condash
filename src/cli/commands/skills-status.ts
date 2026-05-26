/**
 * Read-only `condash skills` verbs — `list`, `status`, `validate`.
 *
 * All three functions are pure observation: no writes, no manifest mutation.
 * `installRepo` writes the manifest; everything here reads it.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { MANIFEST_VERSION, readManifest, sha256, type Manifest } from './install-shared';
import {
  SHIPPED_FILES,
  listShippedFiles,
  sourceMissingFileRows,
  statusShippedFile,
  type FileListRow,
  type FileStatusRow,
} from './files';
import {
  NOUN_FLAGS,
  SOURCE_RELPATH,
  locateShippedSkillsRoot,
  readShippedSkills,
  resolveDest,
} from './skills-shipped';

export interface RepoListReport {
  destination: string | null;
  skills: {
    name: string;
    description: string | null;
    shippedFiles: number;
    installed: number;
  }[];
  files: FileListRow[];
}

export async function listRepo(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const shipped = await readShippedSkills();
  const dest = await resolveDest(args).catch(() => null);
  delete args.flags.dest;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const manifest = dest ? await readManifest(dest) : null;
  const skillsRows = shipped.map((s) => {
    const installedFiles = manifest?.skills[s.name]?.source;
    return {
      name: s.name,
      description: s.description,
      shippedFiles: s.files.length,
      installed: installedFiles ? Object.keys(installedFiles).length : 0,
    };
  });
  const fileRows = listShippedFiles(manifest);
  const report: RepoListReport = { destination: dest, skills: skillsRows, files: fileRows };
  emit(
    ctx,
    report,
    (data) => {
      const d = data as RepoListReport;
      const lines: string[] = [];
      if (d.destination) lines.push(`Destination: ${d.destination}`);
      if (d.skills.length > 0) {
        lines.push(`Skills (${SOURCE_RELPATH}/):`);
        for (const r of d.skills) {
          const status =
            r.installed > 0 ? `${r.installed}/${r.shippedFiles} files installed` : 'not installed';
          lines.push(`  ${r.name.padEnd(16)} ${status.padEnd(28)} ${r.description ?? ''}`);
        }
      }
      if (d.files.length > 0) {
        lines.push(`Files (top-level):`);
        for (const r of d.files) {
          const status = r.installed ? `installed (${r.shippedVersion ?? '?'})` : 'not installed';
          lines.push(`  ${r.path.padEnd(16)} ${r.region.padEnd(12)} ${status}`);
        }
      }
      return lines.join('\n') + '\n';
    },
    [],
  );
}

export type SkillFileState =
  | 'unchanged'
  | 'edited'
  | 'missing'
  | 'orphan'
  | 'outdated'
  | 'source-missing';

export interface SkillStatusRow {
  skill: string;
  file: string;
  state: SkillFileState;
  shippedVersion: string | null;
}

export interface RepoStatusReport {
  destination: string;
  items: SkillStatusRow[];
  files: FileStatusRow[];
}

export async function repoStatus(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const dest = await resolveDest(args);
  delete args.flags.dest;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const sourceRoot = join(dest, SOURCE_RELPATH);
  const shipped = await readShippedSkills();
  const manifest: Manifest = (await readManifest(dest)) ?? {
    version: MANIFEST_VERSION,
    skills: {},
  };
  const shippedByName = new Map(shipped.map((s) => [s.name, s]));

  const skillRows: SkillStatusRow[] = [];

  for (const [skillName, skillEntry] of Object.entries(manifest.skills)) {
    const ship = shippedByName.get(skillName);
    for (const [relPath, entry] of Object.entries(skillEntry.source)) {
      const onDiskPath = join(sourceRoot, skillName, relPath);
      let onDisk: Buffer | null = null;
      try {
        onDisk = await fs.readFile(onDiskPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (onDisk === null) {
        skillRows.push({
          skill: skillName,
          file: relPath,
          state: 'missing',
          shippedVersion: entry.shippedVersion,
        });
        continue;
      }
      const onDiskHash = sha256(onDisk);
      if (onDiskHash !== entry.sha256) {
        skillRows.push({
          skill: skillName,
          file: relPath,
          state: 'edited',
          shippedVersion: entry.shippedVersion,
        });
        continue;
      }
      let shippedFile: Buffer | null = null;
      if (ship && ship.files.includes(relPath)) {
        try {
          shippedFile = await fs.readFile(join(ship.sourceDir, relPath));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      if (shippedFile === null) {
        skillRows.push({
          skill: skillName,
          file: relPath,
          state: 'source-missing',
          shippedVersion: entry.shippedVersion,
        });
        continue;
      }
      if (sha256(shippedFile) !== entry.sha256) {
        skillRows.push({
          skill: skillName,
          file: relPath,
          state: 'outdated',
          shippedVersion: entry.shippedVersion,
        });
      } else {
        skillRows.push({
          skill: skillName,
          file: relPath,
          state: 'unchanged',
          shippedVersion: entry.shippedVersion,
        });
      }
    }
  }

  for (const skill of shipped) {
    const skillManifest = manifest.skills[skill.name]?.source ?? {};
    for (const relPath of skill.files) {
      const onDiskPath = join(sourceRoot, skill.name, relPath);
      try {
        await fs.access(onDiskPath);
      } catch {
        continue;
      }
      if (!skillManifest[relPath]) {
        skillRows.push({
          skill: skill.name,
          file: relPath,
          state: 'orphan',
          shippedVersion: null,
        });
      }
    }
  }

  const fileRows: FileStatusRow[] = [];
  for (const file of SHIPPED_FILES) {
    const row = await statusShippedFile(file, dest, manifest);
    if (row) fileRows.push(row);
  }
  for (const row of sourceMissingFileRows(manifest)) fileRows.push(row);

  const report: RepoStatusReport = { destination: sourceRoot, items: skillRows, files: fileRows };

  emit(
    ctx,
    report,
    (data) => {
      const d = data as RepoStatusReport;
      const lines: string[] = [];
      if (d.items.length === 0 && d.files.length === 0) {
        return `(nothing tracked under ${d.destination})\n`;
      }
      if (d.items.length > 0) {
        const widths = {
          skill: Math.max(5, ...d.items.map((r) => r.skill.length)),
          file: Math.max(4, ...d.items.map((r) => r.file.length)),
          state: 14,
        };
        for (const r of d.items) {
          lines.push(
            `  ${r.skill.padEnd(widths.skill)}  ${r.file.padEnd(widths.file)}  ${r.state.padEnd(widths.state)}  ${r.shippedVersion ?? '-'}`,
          );
        }
      }
      if (d.files.length > 0) {
        if (d.items.length > 0) lines.push('');
        const widths = {
          path: Math.max(4, ...d.files.map((r) => r.path.length)),
          region: Math.max(6, ...d.files.map((r) => r.region.length)),
          state: 16,
        };
        for (const r of d.files) {
          lines.push(
            `  ${r.path.padEnd(widths.path)}  ${r.region.padEnd(widths.region)}  ${r.state.padEnd(widths.state)}  ${r.shippedVersion ?? '-'}`,
          );
        }
      }
      return lines.join('\n') + '\n';
    },
    [],
  );
}

export interface ValidateReport {
  source: string;
  skills: { name: string; errors: string[] }[];
}

export async function validateSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const requestedNames = args.positional.length > 0 ? args.positional : null;
  delete args.flags.dest;
  assertNoExtraFlags(args, NOUN_FLAGS);

  const shipped = await readShippedSkills();
  const selected = requestedNames
    ? shipped.filter((s) => requestedNames.includes(s.name))
    : shipped;
  if (requestedNames) {
    const known = new Set(shipped.map((s) => s.name));
    const missing = requestedNames.filter((n) => !known.has(n));
    if (missing.length > 0) {
      throw new CliError(ExitCodes.NOT_FOUND, `Unknown skill(s): ${missing.join(', ')}`, {
        available: shipped.map((s) => s.name),
      });
    }
  }

  const report: ValidateReport = {
    source: locateShippedSkillsRoot(),
    skills: [],
  };

  for (const skill of selected) {
    const errors: string[] = [];
    if (!skill.files.includes('SKILL.md')) {
      errors.push('missing SKILL.md');
    } else if (skill.description === null) {
      errors.push('SKILL.md has no `description` in its frontmatter');
    }
    report.skills.push({ name: skill.name, errors });
  }

  const totalErrors = report.skills.reduce((acc, s) => acc + s.errors.length, 0);
  emit(ctx, report, (data) => {
    const d = data as ValidateReport;
    const lines: string[] = [`Source: ${d.source}`];
    for (const s of d.skills) {
      if (s.errors.length === 0) {
        lines.push(`  ✓ ${s.name}`);
      } else {
        lines.push(`  ✗ ${s.name}`);
        for (const e of s.errors) lines.push(`      ${e}`);
      }
    }
    return lines.join('\n') + '\n';
  });

  if (totalErrors > 0) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `${totalErrors} validation error(s) across ${report.skills.filter((s) => s.errors.length > 0).length} skill(s)`,
      { skills: report.skills.filter((s) => s.errors.length > 0) },
    );
  }
}
