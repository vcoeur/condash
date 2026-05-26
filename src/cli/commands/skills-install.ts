/**
 * `condash skills install` (repo scope).
 *
 * condash does exactly two things with agent config in a conception:
 *
 *   1. **Ship the skill sources** under `<dest>/.agents/skills/<name>/` —
 *      `SKILL.md` (+ optional task `.md` files and an optional
 *      `SKILL.<harness>.md` overlay), copied verbatim with refuse-on-edit.
 *      condash no longer compiles them to per-harness dirs; the harness
 *      launcher renders them per agent at run time.
 *   2. **Maintain the `AGENTS.md` marker region** — regenerate the head (line 1
 *      through `<!-- end condash agents -->`), preserve the user-owned tail.
 *
 * No top-level files ship today (condash dropped `.gitignore` after v4.0.1);
 * the region-delimited files lane (`SHIPPED_FILES`) stays wired but empty.
 * Skill sources flow through one manifest (`.agents/.condash-skills.json`)
 * with refuse-on-edit; `AGENTS.md` is deterministic (marker boundary) and not
 * manifest-tracked.
 */

import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import {
  cheapDiff,
  readManifest,
  sha256,
  writeFileMkdir,
  writeManifest,
  MANIFEST_VERSION,
  type Manifest,
} from './install-shared';
import {
  AGENTS_MD_PATH,
  SHIPPED_FILES,
  installAgentsMd,
  installShippedFile,
  pruneSourceMissingFileEntries,
  sourceMissingFileRows,
  type AgentsMdOutcome,
  type FileInstallOutcome,
  type ShippedFile,
} from './files';
import {
  NOUN_FLAGS,
  SOURCE_RELPATH,
  readShippedSkills,
  resolveDest,
  type ShippedSkill,
} from './skills-shipped';
import { pruneSourceMissingSkillEntries } from './skills-manifest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface InstallReport {
  destination: string;
  conceptionRoot: string;
  copied: { skill: string; relPath: string }[];
  updated: { skill: string; relPath: string }[];
  unchanged: { skill: string; relPath: string }[];
  refused: { skill: string; relPath: string; reason: string }[];
  forced: { skill: string; relPath: string }[];
  sourceMissing: { skill: string; relPath: string; shippedVersion: string }[];
  files: {
    copied: { path: string; region: string }[];
    updated: { path: string; region: string }[];
    unchanged: { path: string; region: string }[];
    refused: { path: string; region: string; reason: string }[];
    forced: { path: string; region: string }[];
    sourceMissing: { path: string; region: string; shippedVersion: string }[];
  };
  agentsMd: AgentsMdOutcome | null;
  pruned?: {
    skills: { skill: string; relPath: string; shippedVersion: string }[];
    files: { path: string; region: string; shippedVersion: string }[];
  };
  diffs?: { kind: 'skill' | 'file'; label: string; diff: string }[];
}

export async function installRepo(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const shipped = await readShippedSkills();
  const requested = args.positional.length > 0 ? args.positional : null;

  // Partition positionals: skill names vs file paths vs AGENTS.md vs unknown.
  const skillNameSet = new Set(shipped.map((s) => s.name));
  const filePathSet = new Set(SHIPPED_FILES.map((f) => f.path));
  let selectedSkills: ShippedSkill[];
  let selectedFiles: ShippedFile[];
  let installAgents: boolean;
  if (requested) {
    const unknown: string[] = [];
    const skillNames = new Set<string>();
    const filePaths = new Set<string>();
    installAgents = false;
    for (const pos of requested) {
      if (skillNameSet.has(pos)) skillNames.add(pos);
      else if (filePathSet.has(pos)) filePaths.add(pos);
      else if (pos === AGENTS_MD_PATH) installAgents = true;
      else unknown.push(pos);
    }
    if (unknown.length > 0) {
      throw new CliError(ExitCodes.NOT_FOUND, `Unknown skill or file: ${unknown.join(', ')}`, {
        availableSkills: shipped.map((s) => s.name),
        availableFiles: [...SHIPPED_FILES.map((f) => f.path), AGENTS_MD_PATH],
      });
    }
    selectedSkills = shipped.filter((s) => skillNames.has(s.name));
    selectedFiles = SHIPPED_FILES.filter((f) => filePaths.has(f.path));
  } else {
    selectedSkills = shipped;
    selectedFiles = SHIPPED_FILES;
    installAgents = true;
  }

  const dest = await resolveDest(args);
  const sourceRoot = join(dest, SOURCE_RELPATH);
  await fs.mkdir(sourceRoot, { recursive: true });

  const force = args.flags.force === true;
  const showDiff = args.flags.diff === true;
  const dryRun = args.flags['dry-run'] === true;
  const prune = args.flags.prune === true;
  for (const k of ['dest', 'force', 'diff', 'dry-run', 'prune']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const shippedVersion = process.env.CONDASH_CLI_VERSION ?? 'dev';

  const manifest: Manifest = (await readManifest(dest)) ?? {
    version: MANIFEST_VERSION,
    skills: {},
  };

  const report: InstallReport = {
    destination: sourceRoot,
    conceptionRoot: dest,
    copied: [],
    updated: [],
    unchanged: [],
    refused: [],
    forced: [],
    sourceMissing: [],
    files: {
      copied: [],
      updated: [],
      unchanged: [],
      refused: [],
      forced: [],
      sourceMissing: [],
    },
    agentsMd: null,
    diffs: showDiff ? [] : undefined,
  };

  // Pass 1: install skill sources with refuse-on-edit, placing the source
  // layout verbatim (SKILL.md + tasks + SKILL.<harness>.md). No compile.
  for (const skill of selectedSkills) {
    if (!manifest.skills[skill.name]) {
      manifest.skills[skill.name] = { source: {} };
    }
    const skillManifest = manifest.skills[skill.name];

    for (const relPath of skill.files) {
      const sourcePath = join(skill.sourceDir, relPath);
      let sourceContent: Buffer;
      try {
        sourceContent = await fs.readFile(sourcePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          const tracked = skillManifest.source[relPath];
          if (tracked) {
            report.sourceMissing.push({
              skill: skill.name,
              relPath,
              shippedVersion: tracked.shippedVersion,
            });
          }
          continue;
        }
        throw err;
      }
      const sourceHash = sha256(sourceContent);
      const targetPath = join(sourceRoot, skill.name, relPath);

      let onDisk: Buffer | null = null;
      try {
        onDisk = await fs.readFile(targetPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      if (onDisk === null) {
        if (!dryRun) await writeFileMkdir(targetPath, sourceContent);
        skillManifest.source[relPath] = { sha256: sourceHash, shippedVersion };
        report.copied.push({ skill: skill.name, relPath });
        continue;
      }

      const onDiskHash = sha256(onDisk);
      if (onDiskHash === sourceHash) {
        report.unchanged.push({ skill: skill.name, relPath });
        skillManifest.source[relPath] = { sha256: sourceHash, shippedVersion };
        continue;
      }

      const tracked = skillManifest.source[relPath];
      if (tracked && tracked.sha256 === onDiskHash) {
        if (!dryRun) await writeFileMkdir(targetPath, sourceContent);
        skillManifest.source[relPath] = { sha256: sourceHash, shippedVersion };
        report.updated.push({ skill: skill.name, relPath });
        continue;
      }

      if (showDiff) {
        report.diffs!.push({
          kind: 'skill',
          label: `${skill.name}/${relPath}`,
          diff: cheapDiff(onDisk.toString('utf8'), sourceContent.toString('utf8')),
        });
      }
      if (force) {
        if (!dryRun) await writeFileMkdir(targetPath, sourceContent);
        skillManifest.source[relPath] = { sha256: sourceHash, shippedVersion };
        report.forced.push({ skill: skill.name, relPath });
      } else {
        report.refused.push({
          skill: skill.name,
          relPath,
          reason: tracked ? 'edited since last install' : 'present but not tracked by manifest',
        });
      }
    }
  }

  // Pass 2: install the region-delimited top-level files (`.gitignore`).
  for (const file of selectedFiles) {
    const outcome = await installShippedFile(file, {
      dest,
      shippedVersion,
      force,
      showDiff,
      dryRun,
      manifest,
    });
    recordFileOutcome(report, outcome);
  }

  // Pass 3: maintain the AGENTS.md marker region (head regenerated, tail kept).
  if (installAgents) {
    report.agentsMd = await installAgentsMd(dest, dryRun);
  }

  // --prune: drop manifest entries whose shipped source is gone.
  if (prune) {
    const prunedSkills = pruneSourceMissingSkillEntries(manifest, shipped);
    const prunedFiles = pruneSourceMissingFileEntries(manifest);
    report.pruned = { skills: prunedSkills, files: prunedFiles };
  } else {
    // Even without --prune, surface source-missing entries so the user knows
    // to clean up.
    const skillNames = new Set(shipped.map((s) => s.name));
    for (const [name, entry] of Object.entries(manifest.skills)) {
      if (skillNames.has(name)) continue;
      let version: string | undefined;
      for (const [relPath, fileEntry] of Object.entries(entry.source)) {
        version ??= fileEntry.shippedVersion;
        report.sourceMissing.push({ skill: name, relPath, shippedVersion: version });
      }
    }
    for (const row of sourceMissingFileRows(manifest)) {
      report.files.sourceMissing.push({
        path: row.path,
        region: row.region,
        shippedVersion: row.shippedVersion ?? 'unknown',
      });
    }
  }

  if (!dryRun) await writeManifest(dest, manifest);

  emit(ctx, report, formatInstallHuman);
  if (report.refused.length + report.files.refused.length > 0 && !force) {
    const refused = [
      ...report.refused.map((f) => ({
        kind: 'skill',
        label: `${f.skill}/${f.relPath}`,
        reason: f.reason,
      })),
      ...report.files.refused.map((f) => ({ kind: 'file', label: f.path, reason: f.reason })),
    ];
    throw new CliError(
      ExitCodes.VALIDATION,
      `${refused.length} item(s) refused (locally edited). Re-run with --force to overwrite or --diff to inspect.`,
      { refused },
    );
  }
}

function recordFileOutcome(report: InstallReport, outcome: FileInstallOutcome): void {
  const ref = { path: outcome.path, region: outcome.region };
  if (outcome.diff !== undefined && report.diffs) {
    report.diffs.push({ kind: 'file', label: outcome.path, diff: outcome.diff });
  }
  switch (outcome.state) {
    case 'copied':
      report.files.copied.push(ref);
      break;
    case 'updated':
      report.files.updated.push(ref);
      break;
    case 'unchanged':
      report.files.unchanged.push(ref);
      break;
    case 'forced':
      report.files.forced.push(ref);
      break;
    case 'refused':
      report.files.refused.push({ ...ref, reason: outcome.reason ?? 'refused' });
      break;
    case 'source-missing':
      // Surfaced via the manifest walk so the row carries shippedVersion.
      break;
  }
}

function formatInstallHuman(report: InstallReport): string {
  const lines: string[] = [];
  lines.push(`Source-of-truth: ${report.destination}`);
  if (report.copied.length > 0) {
    lines.push(`Sources copied (${report.copied.length}):`);
    for (const f of report.copied) lines.push(`  + ${f.skill}/${f.relPath}`);
  }
  if (report.updated.length > 0) {
    lines.push(`Sources updated (${report.updated.length}):`);
    for (const f of report.updated) lines.push(`  ↻ ${f.skill}/${f.relPath}`);
  }
  if (report.unchanged.length > 0) {
    lines.push(`Sources unchanged: ${report.unchanged.length}`);
  }
  if (report.forced.length > 0) {
    lines.push(`Sources forced (${report.forced.length}):`);
    for (const f of report.forced) lines.push(`  ! ${f.skill}/${f.relPath}`);
  }
  if (report.refused.length > 0) {
    lines.push(`Sources refused (${report.refused.length}):`);
    for (const f of report.refused) {
      lines.push(`  × ${f.skill}/${f.relPath}  (${f.reason})`);
    }
  }
  if (report.files.copied.length > 0) {
    lines.push(`Files copied (${report.files.copied.length}):`);
    for (const f of report.files.copied) lines.push(`  + ${f.path}  (${f.region})`);
  }
  if (report.files.updated.length > 0) {
    lines.push(`Files updated (${report.files.updated.length}):`);
    for (const f of report.files.updated) lines.push(`  ↻ ${f.path}  (${f.region})`);
  }
  if (report.files.unchanged.length > 0) {
    lines.push(`Files unchanged: ${report.files.unchanged.length}`);
  }
  if (report.files.forced.length > 0) {
    lines.push(`Files forced (${report.files.forced.length}):`);
    for (const f of report.files.forced) lines.push(`  ! ${f.path}  (${f.region})`);
  }
  if (report.files.refused.length > 0) {
    lines.push(`Files refused (${report.files.refused.length}):`);
    for (const f of report.files.refused) {
      lines.push(`  × ${f.path}  (${f.reason})`);
    }
  }
  if (report.agentsMd && report.agentsMd.state !== 'unchanged') {
    lines.push(`AGENTS.md (${report.agentsMd.state}): ${report.agentsMd.path}`);
  }
  if (report.sourceMissing.length > 0 || report.files.sourceMissing.length > 0) {
    const total = report.sourceMissing.length + report.files.sourceMissing.length;
    lines.push(`Source-missing (${total}, run with --prune to drop from manifest):`);
    for (const f of report.sourceMissing) {
      lines.push(`  ⊘ ${f.skill}/${f.relPath}  (last shipped ${f.shippedVersion})`);
    }
    for (const f of report.files.sourceMissing) {
      lines.push(`  ⊘ ${f.path}  (last shipped ${f.shippedVersion})`);
    }
  }
  if (report.pruned) {
    const total = report.pruned.skills.length + report.pruned.files.length;
    if (total > 0) {
      lines.push(`Pruned (${total}):`);
      for (const f of report.pruned.skills) {
        lines.push(`  − ${f.skill}/${f.relPath}  (last shipped ${f.shippedVersion})`);
      }
      for (const f of report.pruned.files) {
        lines.push(`  − ${f.path}  (last shipped ${f.shippedVersion})`);
      }
    }
  }
  if (report.diffs && report.diffs.length > 0) {
    for (const d of report.diffs) {
      lines.push('');
      lines.push(`--- diff: ${d.label}`);
      lines.push(d.diff);
    }
  }
  return lines.join('\n') + '\n';
}
