/**
 * `condash skills <list|install|status|validate>`
 *
 * Single CLI verb for everything condash drops into a conception:
 *
 *   - **Agent skills** under `<dest>/.agents/skills/<name>/` (skillspec
 *     sources: `spec.yaml` + `body.md` + optional `targets/<claude|kimi>.yaml`
 *     overlays + arbitrary sibling assets). The skillspec compiler in
 *     `src/skillspec/` turns each spec into agent-native skill files for
 *     Claude (`.claude/skills/`) and Kimi (`.kimi/skills/`).
 *   - **Top-level files** at the conception root (e.g. `AGENTS.md`,
 *     `.gitignore`). Each ships the body of one heading-delimited region;
 *     the surrounding text is user-owned and never touched. AGENTS.md
 *     additionally compiles to `.claude/CLAUDE.md` and `.kimi/AGENTS.md`
 *     (target-specific section stripping + variable substitution).
 *
 * Both kinds flow through one manifest at
 * `<dest>/.claude/skills/.condash-skills.json` (v3 schema: `skills.<name>`
 * + `files.<path>`) and share the same refuse-on-edit semantics — if the
 * user edited a tracked source, condash refuses without `--force`.
 *
 * Positionals accept either a skill name (`pr`, `knowledge`, …) or a
 * shipped-file path (`AGENTS.md`, `.gitignore`). With no positionals,
 * everything installs. Unknown positionals error.
 *
 * Two scopes, selected by flag:
 *
 *   • **Repo scope (default)** — installs the artefacts condash ships into
 *     the resolved conception. Pass 1: copy skill source files + write
 *     top-level file regions, both refuse-on-edit. Pass 2: always-compile
 *     (skillspec → target trees, AGENTS.md → per-target outputs) regardless
 *     of pass-1 refusals; the on-disk source is what compiles, so a user-
 *     edited skill body still propagates to `.claude/skills/`.
 *
 *   • **User scope (`--user`)** — compiles user-owned skillspecs at
 *     `~/.config/agents/skills/<name>/` into `~/.claude/skills/<name>/`
 *     + `~/.kimi/skills/<name>/`. No pass-1, no manifest, no top-level
 *     files: the user owns the source tree directly and compiled outputs
 *     are always regenerated. Specs may declare a `hosts:` list; condash
 *     reads `~/.claude/.host` and skips skills whose `hosts:` doesn't
 *     include the current host label.
 *
 * Flags:
 *
 *   `--dest <path>`   retargets the repo-scope install dir (default:
 *                     conception root or cwd). Incompatible with `--user`.
 *   `--user`          switch to user scope. Incompatible with `--dest`.
 *   `--force`         repo scope only: override refuse-on-edit.
 *   `--diff`          repo scope only: show a unified diff per refused item.
 *   `--prune`         repo scope only: drop manifest entries whose shipped
 *                     source has been removed from the bundle (cleans up
 *                     residue from older condash versions).
 *   `--dry-run`       report what would be written without touching disk.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';
import { type AgentsMdTarget } from '../../agents-md';
import {
  COMPILE_TARGETS,
  compileSkillspec,
  parseSkillspec,
  SkillspecError,
  type CompileTarget,
} from '../../skillspec';
import {
  MANIFEST_RELPATH,
  MANIFEST_VERSION,
  cheapDiff,
  readManifest,
  sha256,
  writeFileMkdir,
  writeManifest,
  type Manifest,
} from './install-shared';
import {
  SHIPPED_FILES,
  compileAgentConfigs,
  installAgentConfigSources,
  installShippedFile,
  listShippedFiles,
  locateShippedFilesRoot,
  pruneSourceMissingFileEntries,
  sourceMissingFileRows,
  statusShippedFile,
  type FileInstallOutcome,
  type FileListRow,
  type FileStatusRow,
  type ShippedFile,
} from './files';

const KNOWN_FLAGS_LIST = ['dest', 'user'] as const;
const KNOWN_FLAGS_INSTALL = ['dest', 'user', 'force', 'diff', 'dry-run', 'prune'] as const;
const KNOWN_FLAGS_STATUS = ['dest', 'user'] as const;
const KNOWN_FLAGS_VALIDATE = ['dest', 'user'] as const;

const NOUN_FLAGS: readonly string[] = [
  ...new Set<string>([
    ...KNOWN_FLAGS_LIST,
    ...KNOWN_FLAGS_INSTALL,
    ...KNOWN_FLAGS_STATUS,
    ...KNOWN_FLAGS_VALIDATE,
  ]),
];

/** Path of the skillspec source tree relative to the conception root. */
const SOURCE_RELPATH = '.agents/skills';

/** Path of compiled outputs relative to the conception root, per target. */
const TARGET_RELPATHS: Record<CompileTarget, string> = {
  claude: '.claude/skills',
  kimi: '.kimi/skills',
};

interface ShippedSkill {
  name: string;
  /** Absolute source dir under conception-template/.agents/skills/<name>/. */
  sourceDir: string;
  /** Source files relative to sourceDir, recursively (excluding hidden). */
  files: string[];
  /** Description from spec.yaml, if parseable. */
  description: string | null;
}

export async function runSkills(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  universalHelp = false,
): Promise<void> {
  if (verb === 'help') {
    printHelp(args.positional[0] ?? null);
    return;
  }
  if (universalHelp) {
    printHelp(verb);
    return;
  }
  const userScope = args.flags.user === true;
  if (userScope && args.flags.dest !== undefined) {
    throw new CliError(ExitCodes.USAGE, '`--user` is incompatible with `--dest`');
  }
  switch (verb) {
    case null:
    case 'list':
      return userScope ? await listUser(args, ctx) : await listRepo(args, ctx);
    case 'install':
      return userScope ? await installUserSkills(args, ctx) : await installRepo(args, ctx);
    case 'status':
      return userScope ? await userSkillsStatus(args, ctx) : await repoStatus(args, ctx);
    case 'validate':
      return userScope ? await validateUserSkills(args, ctx) : await validateSkills(args, ctx);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown skills verb: ${verb}`);
  }
}

interface RepoListReport {
  destination: string | null;
  skills: {
    name: string;
    description: string | null;
    shippedFiles: number;
    installed: number;
  }[];
  files: FileListRow[];
}

async function listRepo(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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

interface InstallReport {
  destination: string;
  conceptionRoot: string;
  outputs: Record<CompileTarget, string>;
  copied: { skill: string; relPath: string }[];
  updated: { skill: string; relPath: string }[];
  unchanged: { skill: string; relPath: string }[];
  refused: { skill: string; relPath: string; reason: string }[];
  forced: { skill: string; relPath: string }[];
  sourceMissing: { skill: string; relPath: string; shippedVersion: string }[];
  compiled: { skill: string; target: CompileTarget; relPath: string }[];
  files: {
    copied: { path: string; region: string }[];
    updated: { path: string; region: string }[];
    unchanged: { path: string; region: string }[];
    refused: { path: string; region: string; reason: string }[];
    forced: { path: string; region: string }[];
    sourceMissing: { path: string; region: string; shippedVersion: string }[];
  };
  agentsMdCompiled: { target: AgentsMdTarget; path: string }[];
  agentConfigsCopied: string[];
  pruned?: {
    skills: { skill: string; relPath: string; shippedVersion: string }[];
    files: { path: string; region: string; shippedVersion: string }[];
  };
  diffs?: { kind: 'skill' | 'file'; label: string; diff: string }[];
}

async function installRepo(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const shipped = await readShippedSkills();
  const requested = args.positional.length > 0 ? args.positional : null;

  // Partition positionals: skill names vs file paths vs unknown.
  const skillNameSet = new Set(shipped.map((s) => s.name));
  const filePathSet = new Set(SHIPPED_FILES.map((f) => f.path));
  let selectedSkills: ShippedSkill[];
  let selectedFiles: ShippedFile[];
  if (requested) {
    const unknown: string[] = [];
    const skillNames = new Set<string>();
    const filePaths = new Set<string>();
    for (const pos of requested) {
      if (skillNameSet.has(pos)) skillNames.add(pos);
      else if (filePathSet.has(pos)) filePaths.add(pos);
      else unknown.push(pos);
    }
    if (unknown.length > 0) {
      throw new CliError(ExitCodes.NOT_FOUND, `Unknown skill or file: ${unknown.join(', ')}`, {
        availableSkills: shipped.map((s) => s.name),
        availableFiles: SHIPPED_FILES.map((f) => f.path),
      });
    }
    selectedSkills = shipped.filter((s) => skillNames.has(s.name));
    selectedFiles = SHIPPED_FILES.filter((f) => filePaths.has(f.path));
  } else {
    selectedSkills = shipped;
    selectedFiles = SHIPPED_FILES;
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
    outputs: {
      claude: join(dest, TARGET_RELPATHS.claude),
      kimi: join(dest, TARGET_RELPATHS.kimi),
    },
    copied: [],
    updated: [],
    unchanged: [],
    refused: [],
    forced: [],
    sourceMissing: [],
    compiled: [],
    files: {
      copied: [],
      updated: [],
      unchanged: [],
      refused: [],
      forced: [],
      sourceMissing: [],
    },
    agentsMdCompiled: [],
    agentConfigsCopied: [],
    diffs: showDiff ? [] : undefined,
  };

  // Pass 1a: install skill sources with refuse-on-edit.
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
          // Shouldn't happen — readShippedSkills only returns existing files.
          // Guard anyway: a vanished source surfaces as source-missing per file.
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

  // Pass 1b: install top-level files (region-style).
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

  // Pass 2a: compile every skill on disk (not just the selected slice; the
  // user may have skills installed from a previous run, and stale compiled
  // outputs left behind by a partial run would be confusing). Compile reads
  // the on-disk source, so a refused (= locally-edited) source still
  // propagates to the target trees — that's the install/compile decoupling
  // promise.
  const compileTargets = await collectInstalledSkillNames(sourceRoot, shipped);

  // Per-target compiled manifest builders: skillName -> { files: { relPath -> entry } }
  const compiledManifests: Record<
    CompileTarget,
    Record<string, { files: Record<string, { sha256: string; shippedVersion: string }> }>
  > = {
    claude: {},
    kimi: {},
  };

  for (const skillName of compileTargets) {
    const skill = shipped.find((s) => s.name === skillName);
    const compileFromDir = dryRun && skill ? skill.sourceDir : join(sourceRoot, skillName);
    let parsed;
    try {
      parsed = await parseSkillspec(compileFromDir);
    } catch (err) {
      if (err instanceof SkillspecError) {
        // Skip skills whose source is malformed — surface to the user via
        // refusal/diff path during install, not by crashing compile.
        continue;
      }
      throw err;
    }
    for (const target of COMPILE_TARGETS) {
      const compiled = compileSkillspec(parsed, target);
      const outputRoot = join(dest, TARGET_RELPATHS[target], skillName);
      // Wipe stale outputs so previously-shipped-but-now-deleted assets
      // don't linger. Skipped on dry-run.
      if (!dryRun) await rmTreeIfPresent(outputRoot);
      compiledManifests[target][skillName] = { files: {} };
      for (const [relPath, content] of Object.entries(compiled.files)) {
        if (!dryRun) await writeFileMkdir(join(outputRoot, relPath), content);
        report.compiled.push({ skill: skillName, target, relPath });
        compiledManifests[target][skillName].files[relPath] = {
          sha256: sha256(content),
          shippedVersion,
        };
      }
    }
  }

  // Write compiled manifests for each target.
  for (const target of COMPILE_TARGETS) {
    const compiledManifest = {
      version: MANIFEST_VERSION,
      skills: compiledManifests[target],
    };
    const manifestPath = join(dest, TARGET_RELPATHS[target], MANIFEST_RELPATH);
    if (!dryRun) {
      await writeFileMkdir(
        manifestPath,
        Buffer.from(JSON.stringify(compiledManifest, null, 2) + '\n', 'utf8'),
      );
    }
  }

  // Pass 1c: copy agent-config sources.
  report.agentConfigsCopied = await installAgentConfigSources(dest, dryRun);

  // Pass 2b: compile .agents/agents/ → per-target outputs (no-op if source tree isn't on disk).
  report.agentsMdCompiled = await compileAgentConfigs(dest, dryRun);

  // --prune: drop manifest entries whose shipped source is gone.
  if (prune) {
    const prunedSkills = pruneSourceMissingSkillEntries(manifest, shipped);
    const prunedFiles = pruneSourceMissingFileEntries(manifest);
    report.pruned = { skills: prunedSkills, files: prunedFiles };
  } else {
    // Even without --prune, surface source-missing entries in the report so
    // the user knows to clean up. Walk the manifest after the install pass
    // wrote anything new.
    const skillNames = new Set(shipped.map((s) => s.name));
    for (const [name, entry] of Object.entries(manifest.skills)) {
      if (skillNames.has(name)) continue;
      const versions = new Set(Object.values(entry.source).map((f) => f.shippedVersion));
      const version = versions.size > 0 ? Array.from(versions)[0] : 'unknown';
      for (const relPath of Object.keys(entry.source)) {
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
      // Skip — surfaced via the manifest walk so the row carries shippedVersion.
      break;
  }
}

/**
 * The list of skills to compile in pass 2: every skill that has an
 * `.agents/skills/<name>/spec.yaml` on disk after pass 1, plus any
 * currently-shipped skill (caught in the dry-run case where pass 1 didn't
 * write to disk). De-duplicated.
 */
async function collectInstalledSkillNames(
  sourceRoot: string,
  shipped: ShippedSkill[],
): Promise<string[]> {
  const names = new Set<string>();
  for (const s of shipped) names.add(s.name);
  try {
    const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const spec = join(sourceRoot, entry.name, 'spec.yaml');
      try {
        await fs.access(spec);
        names.add(entry.name);
      } catch {
        /* not a skillspec dir — skip */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return [...names].sort();
}

function pruneSourceMissingSkillEntries(
  manifest: Manifest,
  shipped: ShippedSkill[],
): { skill: string; relPath: string; shippedVersion: string }[] {
  const shippedNames = new Set(shipped.map((s) => s.name));
  const dropped: { skill: string; relPath: string; shippedVersion: string }[] = [];
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (shippedNames.has(name)) continue;
    for (const [relPath, fileEntry] of Object.entries(entry.source)) {
      dropped.push({ skill: name, relPath, shippedVersion: fileEntry.shippedVersion });
    }
    delete manifest.skills[name];
  }
  return dropped;
}

async function rmTreeIfPresent(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

function formatInstallHuman(report: InstallReport): string {
  const lines: string[] = [];
  lines.push(`Source-of-truth: ${report.destination}`);
  lines.push(`Compiled → ${report.outputs.claude}`);
  lines.push(`Compiled → ${report.outputs.kimi}`);
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
  if (report.compiled.length > 0) {
    const byTarget = new Map<CompileTarget, number>();
    for (const c of report.compiled) {
      byTarget.set(c.target, (byTarget.get(c.target) ?? 0) + 1);
    }
    const parts = COMPILE_TARGETS.filter((t) => byTarget.has(t)).map(
      (t) => `${t}=${byTarget.get(t)}`,
    );
    lines.push(`Compiled outputs: ${parts.join(', ')}`);
  }
  if (report.agentConfigsCopied.length > 0) {
    lines.push(`Agent configs copied (${report.agentConfigsCopied.length}):`);
    for (const p of report.agentConfigsCopied) lines.push(`  + ${p}`);
  }
  if (report.agentsMdCompiled.length > 0) {
    lines.push(`Compiled agent configs (${report.agentsMdCompiled.length}):`);
    for (const c of report.agentsMdCompiled) lines.push(`  → ${c.path}  (${c.target})`);
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

type SkillFileState = 'unchanged' | 'edited' | 'missing' | 'orphan' | 'outdated' | 'source-missing';

interface SkillStatusRow {
  skill: string;
  file: string;
  state: SkillFileState;
  shippedVersion: string | null;
}

interface RepoStatusReport {
  destination: string;
  items: SkillStatusRow[];
  files: FileStatusRow[];
}

async function repoStatus(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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
        // Either the skill is no longer shipped or the specific file was
        // dropped from the spec. Both surface as source-missing.
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

interface ValidateReport {
  source: string;
  skills: { name: string; errors: string[] }[];
}

async function validateSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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
    try {
      const parsed = await parseSkillspec(skill.sourceDir);
      for (const target of COMPILE_TARGETS) {
        try {
          compileSkillspec(parsed, target);
        } catch (err) {
          errors.push(`compile[${target}]: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (err instanceof SkillspecError) {
        errors.push(err.message);
      } else {
        throw err;
      }
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

async function readShippedSkills(): Promise<ShippedSkill[]> {
  const root = locateShippedSkillsRoot();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    throw new CliError(
      ExitCodes.RUNTIME,
      `Could not read shipped skillspecs at ${root}: ${(err as Error).message}`,
    );
  }
  const out: ShippedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourceDir = join(root, entry.name);
    const files = await collectFilesRelative(sourceDir);
    const description = await extractDescriptionFromSpec(join(sourceDir, 'spec.yaml')).catch(
      () => null,
    );
    out.push({ name: entry.name, sourceDir, files, description });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function locateShippedSkillsRoot(): string {
  const override = process.env.CONDASH_TEMPLATE_ROOT;
  if (override) return join(override, SOURCE_RELPATH);
  return join(__dirname, '..', 'conception-template', SOURCE_RELPATH);
}

async function collectFilesRelative(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const next = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(dir, '');
  out.sort();
  return out;
}

async function extractDescriptionFromSpec(specPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(specPath, 'utf8');
    const match = raw.match(/^description:\s*(.+?)\s*$/m);
    if (!match) return null;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 110) value = value.slice(0, 109) + '…';
    return value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// User-scope (`--user`) install/list/status/validate
//
// In user scope there is no shipped tree and no "copy sources into the
// destination" pass: the user owns the source tree at
// `~/.config/agents/skills/<name>/` directly. The compile pipeline is the
// same one as repo scope (`parseSkillspec` + `compileSkillspec`), pointed
// at different roots, and the outputs land in `~/.claude/skills/` and
// `~/.kimi/skills/`. Outputs are always regenerated and not tracked by any
// manifest (no refuse-on-edit semantics — the user knows the outputs are
// derived).
//
// The `hosts:` field on a spec.yaml restricts a skill to a list of host
// labels (e.g. `hosts: [vcoeur]`). When present, condash reads the host
// label from `~/.claude/.host` (single line, whitespace-stripped) and
// skips skills whose `hosts:` does not contain the current label. This
// is the multi-host filter previously enforced by ClaudeConfig's
// `/sync-config`; moving it here lets a single source-of-truth feed all
// hosts without per-host pruning at sync time.
//
// Paths are env-overridable for tests:
//   CONDASH_USER_SKILLS_ROOT  — replaces ~/.config/agents/skills
//   CONDASH_USER_CLAUDE_ROOT  — replaces ~/.claude/skills
//   CONDASH_USER_KIMI_ROOT    — replaces ~/.kimi/skills
//   CONDASH_USER_HOST_FILE    — replaces ~/.claude/.host
// ---------------------------------------------------------------------------

interface UserSkill {
  name: string;
  sourceDir: string;
  files: string[];
  description: string | null;
  /** Parsed `hosts:` list from spec.yaml; null if the field is absent. */
  hosts: string[] | null;
}

type ScriptCategory = 'agents' | 'claude';

interface UserScript {
  category: ScriptCategory;
  source: string;
  target: string;
  relPath: string;
}

interface UserScriptsReport {
  sources: Record<ScriptCategory, string>;
  targets: Record<ScriptCategory, string>;
  installed: { category: ScriptCategory; relPath: string }[];
}

interface UserInstallReport {
  source: string;
  outputs: Record<CompileTarget, string>;
  hostLabel: string | null;
  skipped: { skill: string; hosts: string[] }[];
  compiled: { skill: string; target: CompileTarget; relPath: string }[];
  scripts: UserScriptsReport;
}

function userSourceRoot(): string {
  return process.env.CONDASH_USER_SKILLS_ROOT ?? join(homedir(), '.config', 'agents', 'skills');
}

function userTargetRoot(target: CompileTarget): string {
  const envName = target === 'claude' ? 'CONDASH_USER_CLAUDE_ROOT' : 'CONDASH_USER_KIMI_ROOT';
  return process.env[envName] ?? join(homedir(), `.${target}`, 'skills');
}

function userScriptSourceRoot(category: ScriptCategory): string {
  if (category === 'agents') {
    return (
      process.env.CONDASH_USER_AGENTS_SCRIPTS_ROOT
      ?? join(homedir(), '.config', 'agents', 'agents-scripts')
    );
  }
  return (
    process.env.CONDASH_USER_CLAUDE_SCRIPTS_ROOT
    ?? join(homedir(), '.config', 'agents', 'claude-scripts')
  );
}

function userScriptTargetRoot(category: ScriptCategory): string {
  if (category === 'agents') {
    return (
      process.env.CONDASH_USER_AGENTS_SCRIPTS_TARGET
      ?? join(homedir(), '.config', 'agents', 'scripts')
    );
  }
  return process.env.CONDASH_USER_CLAUDE_SCRIPTS_TARGET ?? join(homedir(), '.claude', 'scripts');
}

function userHostFile(): string {
  return process.env.CONDASH_USER_HOST_FILE ?? join(homedir(), '.claude', '.host');
}

async function readUserScripts(): Promise<UserScript[]> {
  const out: UserScript[] = [];
  for (const category of ['agents', 'claude'] as const) {
    const source = userScriptSourceRoot(category);
    const target = userScriptTargetRoot(category);
    let files: string[];
    try {
      files = await collectFilesRelative(source);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const relPath of files) {
      out.push({ category, source, target, relPath });
    }
  }
  return out;
}

async function readHostLabel(): Promise<string | null> {
  try {
    const raw = await fs.readFile(userHostFile(), 'utf8');
    const label = raw.trim();
    return label.length > 0 ? label : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Coerce a spec.yaml `hosts:` value to a string list, or null if the field
 *  is absent. Accepts a YAML list (`[vcoeur, oomade]`) or a single scalar
 *  treated as a one-element list. */
function normalizeHosts(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return [];
}

async function readUserSkills(): Promise<UserSkill[]> {
  const root = userSourceRoot();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CliError(
      ExitCodes.RUNTIME,
      `Could not read user skillspecs at ${root}: ${(err as Error).message}`,
    );
  }
  const out: UserSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourceDir = join(root, entry.name);
    let hosts: string[] | null = null;
    try {
      const parsed = await parseSkillspec(sourceDir);
      hosts = normalizeHosts(parsed.spec.hosts);
    } catch {
      // Leave hosts as null; validation will catch malformed specs.
    }
    const files = await collectFilesRelative(sourceDir);
    const description = await extractDescriptionFromSpec(join(sourceDir, 'spec.yaml')).catch(
      () => null,
    );
    out.push({ name: entry.name, sourceDir, files, description, hosts });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function hostAllowed(skill: UserSkill, hostLabel: string | null): boolean {
  if (skill.hosts === null) return true;
  if (skill.hosts.length === 0) return true;
  if (hostLabel === null) return false;
  return skill.hosts.includes(hostLabel);
}

async function installUserSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const all = await readUserSkills();
  const requestedNames = args.positional.length > 0 ? args.positional : null;
  if (requestedNames) {
    const known = new Set(all.map((s) => s.name));
    const missing = requestedNames.filter((n) => !known.has(n));
    if (missing.length > 0) {
      throw new CliError(ExitCodes.NOT_FOUND, `Unknown skill(s): ${missing.join(', ')}`, {
        available: all.map((s) => s.name),
      });
    }
  }
  const selected = requestedNames ? all.filter((s) => requestedNames.includes(s.name)) : all;

  const dryRun = args.flags['dry-run'] === true;
  for (const k of ['user', 'dry-run']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);

  const hostLabel = await readHostLabel();
  const report: UserInstallReport = {
    source: userSourceRoot(),
    outputs: { claude: userTargetRoot('claude'), kimi: userTargetRoot('kimi') },
    hostLabel,
    skipped: [],
    compiled: [],
    scripts: {
      sources: {
        agents: userScriptSourceRoot('agents'),
        claude: userScriptSourceRoot('claude'),
      },
      targets: {
        agents: userScriptTargetRoot('agents'),
        claude: userScriptTargetRoot('claude'),
      },
      installed: [],
    },
  };

  for (const skill of selected) {
    if (!hostAllowed(skill, hostLabel)) {
      report.skipped.push({ skill: skill.name, hosts: skill.hosts ?? [] });
      continue;
    }
    const parsed = await parseSkillspec(skill.sourceDir);
    for (const target of COMPILE_TARGETS) {
      const compiled = compileSkillspec(parsed, target);
      const outputRoot = join(userTargetRoot(target), skill.name);
      if (!dryRun) await rmTreeIfPresent(outputRoot);
      for (const [relPath, content] of Object.entries(compiled.files)) {
        if (!dryRun) await writeFileMkdir(join(outputRoot, relPath), content);
        report.compiled.push({ skill: skill.name, target, relPath });
      }
    }
  }

  // Scripts: rsync from staging dirs to final targets with +x. No compile,
  // no manifest, no refuse-on-edit. Always run regardless of skill positional
  // filter — scripts have no spec.yaml and no name addressable on the CLI.
  // Sources silently absent → zero rows, no error.
  const scripts = await readUserScripts();
  for (const script of scripts) {
    const srcPath = join(script.source, script.relPath);
    const dstPath = join(script.target, script.relPath);
    const buf = await fs.readFile(srcPath);
    if (!dryRun) {
      await writeFileMkdir(dstPath, buf);
      await fs.chmod(dstPath, 0o755);
    }
    report.scripts.installed.push({ category: script.category, relPath: script.relPath });
  }

  emit(ctx, report, formatUserInstallHuman);
}

function formatUserInstallHuman(report: UserInstallReport): string {
  const lines: string[] = [];
  lines.push(`Source: ${report.source}`);
  lines.push(`Compiled → ${report.outputs.claude}`);
  lines.push(`Compiled → ${report.outputs.kimi}`);
  if (report.hostLabel !== null) lines.push(`Host: ${report.hostLabel}`);
  if (report.skipped.length > 0) {
    lines.push(`Skipped (host-mismatch, ${report.skipped.length}):`);
    for (const s of report.skipped) {
      lines.push(`  · ${s.skill}  (hosts: ${s.hosts.join(', ') || '[]'})`);
    }
  }
  if (report.compiled.length > 0) {
    const byTarget = new Map<CompileTarget, number>();
    for (const c of report.compiled) byTarget.set(c.target, (byTarget.get(c.target) ?? 0) + 1);
    const parts = COMPILE_TARGETS.filter((t) => byTarget.has(t)).map(
      (t) => `${t}=${byTarget.get(t)}`,
    );
    lines.push(`Compiled outputs: ${parts.join(', ')}`);
  }
  if (report.scripts.installed.length > 0) {
    const byCategory = new Map<ScriptCategory, number>();
    for (const s of report.scripts.installed) {
      byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
    }
    const parts = (['agents', 'claude'] as const)
      .filter((c) => byCategory.has(c))
      .map((c) => `${c}=${byCategory.get(c)}`);
    lines.push(`Scripts installed → ${report.scripts.targets.agents}, ${report.scripts.targets.claude} (${parts.join(', ')})`);
  }
  return lines.join('\n') + '\n';
}

async function listUser(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  delete args.flags.user;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const all = await readUserSkills();
  const hostLabel = await readHostLabel();
  const skillRows = all.map((s) => ({
    name: s.name,
    description: s.description,
    files: s.files.length,
    hosts: s.hosts,
    allowedOnHost: hostAllowed(s, hostLabel),
  }));
  const scripts = await readUserScripts();
  const scriptsByCategory: Record<ScriptCategory, { source: string; target: string; files: string[] }> = {
    agents: {
      source: userScriptSourceRoot('agents'),
      target: userScriptTargetRoot('agents'),
      files: scripts.filter((s) => s.category === 'agents').map((s) => s.relPath),
    },
    claude: {
      source: userScriptSourceRoot('claude'),
      target: userScriptTargetRoot('claude'),
      files: scripts.filter((s) => s.category === 'claude').map((s) => s.relPath),
    },
  };
  emit(
    ctx,
    { source: userSourceRoot(), hostLabel, skills: skillRows, scripts: scriptsByCategory },
    (data) => {
      const d = data as {
        source: string;
        hostLabel: string | null;
        skills: typeof skillRows;
        scripts: typeof scriptsByCategory;
      };
      const lines: string[] = [`Source: ${d.source}`];
      if (d.hostLabel !== null) lines.push(`Host: ${d.hostLabel}`);
      for (const r of d.skills) {
        const hostTag =
          r.hosts === null
            ? ''
            : r.allowedOnHost
              ? ` [hosts: ${r.hosts.join(', ')}]`
              : ' [skipped: not for this host]';
        lines.push(`  ${r.name.padEnd(20)} ${(r.description ?? '').slice(0, 80)}${hostTag}`);
      }
      for (const category of ['agents', 'claude'] as const) {
        const block = d.scripts[category];
        if (block.files.length === 0) continue;
        lines.push(`Scripts (${category}): ${block.source} → ${block.target}`);
        for (const relPath of block.files) lines.push(`  ${relPath}`);
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'skills' },
  );
}

type UserStatusEntry =
  | {
      kind: 'skill';
      skill: string;
      target: CompileTarget;
      relPath: string;
      state: 'ok' | 'stale' | 'missing' | 'skipped';
    }
  | {
      kind: 'script';
      category: ScriptCategory;
      relPath: string;
      state: 'ok' | 'stale' | 'missing';
    };

async function userSkillsStatus(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  delete args.flags.user;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const all = await readUserSkills();
  const hostLabel = await readHostLabel();
  const items: UserStatusEntry[] = [];

  for (const skill of all) {
    if (!hostAllowed(skill, hostLabel)) {
      items.push({
        kind: 'skill',
        skill: skill.name,
        target: 'claude',
        relPath: '-',
        state: 'skipped',
      });
      continue;
    }
    const parsed = await parseSkillspec(skill.sourceDir);
    for (const target of COMPILE_TARGETS) {
      const compiled = compileSkillspec(parsed, target);
      const outputRoot = join(userTargetRoot(target), skill.name);
      for (const [relPath, content] of Object.entries(compiled.files)) {
        const outPath = join(outputRoot, relPath);
        let onDisk: Buffer | null = null;
        try {
          onDisk = await fs.readFile(outPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        let state: 'ok' | 'stale' | 'missing';
        if (onDisk === null) state = 'missing';
        else if (Buffer.compare(onDisk, content) === 0) state = 'ok';
        else state = 'stale';
        items.push({ kind: 'skill', skill: skill.name, target, relPath, state });
      }
    }
  }

  const scripts = await readUserScripts();
  for (const script of scripts) {
    const srcContent = await fs.readFile(join(script.source, script.relPath));
    let onDisk: Buffer | null = null;
    try {
      onDisk = await fs.readFile(join(script.target, script.relPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let state: 'ok' | 'stale' | 'missing';
    if (onDisk === null) state = 'missing';
    else if (Buffer.compare(onDisk, srcContent) === 0) state = 'ok';
    else state = 'stale';
    items.push({ kind: 'script', category: script.category, relPath: script.relPath, state });
  }

  emit(
    ctx,
    { source: userSourceRoot(), hostLabel, items },
    (data) => {
      const d = data as { source: string; hostLabel: string | null; items: UserStatusEntry[] };
      if (d.items.length === 0) return `(nothing tracked under ${d.source})\n`;
      const skillRows = d.items.filter((r): r is Extract<UserStatusEntry, { kind: 'skill' }> => r.kind === 'skill');
      const scriptRows = d.items.filter((r): r is Extract<UserStatusEntry, { kind: 'script' }> => r.kind === 'script');
      const lines: string[] = [];
      if (skillRows.length > 0) {
        const widths = {
          skill: Math.max(5, ...skillRows.map((r) => r.skill.length)),
          target: 6,
          file: Math.max(4, ...skillRows.map((r) => r.relPath.length)),
        };
        for (const r of skillRows) {
          lines.push(
            `  ${r.skill.padEnd(widths.skill)}  ${r.target.padEnd(widths.target)}  ${r.relPath.padEnd(widths.file)}  ${r.state}`,
          );
        }
      }
      if (scriptRows.length > 0) {
        if (skillRows.length > 0) lines.push('');
        const widths = {
          category: Math.max(8, ...scriptRows.map((r) => `script-${r.category}`.length)),
          file: Math.max(4, ...scriptRows.map((r) => r.relPath.length)),
        };
        for (const r of scriptRows) {
          lines.push(
            `  ${`script-${r.category}`.padEnd(widths.category)}  ${r.relPath.padEnd(widths.file)}  ${r.state}`,
          );
        }
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'items' },
  );
}

async function validateUserSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const requestedNames = args.positional.length > 0 ? args.positional : null;
  delete args.flags.user;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const all = await readUserSkills();
  const selected = requestedNames ? all.filter((s) => requestedNames.includes(s.name)) : all;
  if (requestedNames) {
    const known = new Set(all.map((s) => s.name));
    const missing = requestedNames.filter((n) => !known.has(n));
    if (missing.length > 0) {
      throw new CliError(ExitCodes.NOT_FOUND, `Unknown skill(s): ${missing.join(', ')}`, {
        available: all.map((s) => s.name),
      });
    }
  }
  const report: ValidateReport = { source: userSourceRoot(), skills: [] };
  for (const skill of selected) {
    const errors: string[] = [];
    try {
      const parsed = await parseSkillspec(skill.sourceDir);
      for (const target of COMPILE_TARGETS) {
        try {
          compileSkillspec(parsed, target);
        } catch (err) {
          errors.push(`compile[${target}]: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (err instanceof SkillspecError) errors.push(err.message);
      else throw err;
    }
    report.skills.push({ name: skill.name, errors });
  }
  const totalErrors = report.skills.reduce((acc, s) => acc + s.errors.length, 0);
  emit(ctx, report, (data) => {
    const d = data as ValidateReport;
    const lines: string[] = [`Source: ${d.source}`];
    for (const s of d.skills) {
      if (s.errors.length === 0) lines.push(`  ✓ ${s.name}`);
      else {
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

// Re-export utility for tests that previously imported from templates.ts.
// New code should import directly from `./regions` and `./files`.
export { locateShippedFilesRoot };

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'list':
    case null:
      process.stdout.write(
        [
          'condash skills list [--user] [--dest <path>]',
          '',
          'List shipped skills + top-level files (and their install status).',
          '',
          'Optional:',
          '  --user        Switch to user scope (~/.config/agents/skills).',
          '  --dest <path> Override repo-scope destination (default: resolved conception).',
          '',
          'Examples:',
          '  condash skills list',
          '  condash skills list --user',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'install':
      process.stdout.write(
        [
          'condash skills install [<skill-or-file>...] [--user] [--dest <path>]',
          '                       [--force] [--diff] [--dry-run] [--prune]',
          '',
          'Install (or refresh) shipped skills + top-level files into the conception.',
          'Refuses to overwrite user-edited sources unless --force.',
          '',
          'User scope (--user) also installs script trees (rsync + chmod +x, no compile):',
          '  ~/.config/agents/agents-scripts/  → ~/.config/agents/scripts/',
          '  ~/.config/agents/claude-scripts/  → ~/.claude/scripts/',
          'Sources are silently skipped when absent.',
          '',
          'Optional:',
          '  --user        User scope (~/.config/agents/skills → ~/.claude/, ~/.kimi/; plus script trees above).',
          '  --dest <path> Override repo-scope destination.',
          '  --force       Override refuse-on-edit (repo scope only).',
          '  --diff        Show a unified diff per refused item.',
          '  --dry-run     Report what would change; touch nothing.',
          '  --prune       Drop manifest entries whose shipped source has been removed.',
          '',
          'Examples:',
          '  condash skills install',
          '  condash skills install pr knowledge --diff',
          '  condash skills install --user --dry-run',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'status':
      process.stdout.write(
        [
          'condash skills status [--user] [--dest <path>]',
          '',
          'Per-skill / per-file install state (tracked, edited, missing on source).',
          '',
          'Examples:',
          '  condash skills status',
          '  condash skills status --user --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'validate':
      process.stdout.write(
        [
          'condash skills validate [--user] [--dest <path>]',
          '',
          'Lint shipped skill specs + top-level file regions.',
          '',
          'Examples:',
          '  condash skills validate',
          '  condash skills validate --user',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    default:
      printSubHelp();
  }
}

function printSubHelp(): void {
  process.stdout.write(
    [
      'condash skills <verb> [args]',
      '',
      'Verbs:',
      '  list       List shipped skills + top-level files.',
      '  install    Install (or refresh) shipped artefacts.',
      '  status     Per-skill / per-file install state.',
      '  validate   Lint shipped skill specs + top-level file regions.',
      '',
      'Scopes: pass --user for user-scope (~/.config/agents/skills); default is repo scope.',
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}
