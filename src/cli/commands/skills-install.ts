/**
 * `condash skills install` — both scopes.
 *
 * Repo scope (`installRepo`): pass 1 copies skillspec sources and top-level
 * file regions with refuse-on-edit semantics; pass 2 compiles everything on
 * disk (via `compileAllSkillspecs`) so a refused source still propagates
 * through to the per-target trees. Pass 1c copies the agent-config sources
 * (region-aware for `common.md`, overwrite for the per-agent fragments);
 * pass 2b compiles them to `CLAUDE.md` / `AGENTS.md`.
 *
 * User scope (`installUserSkills`): no shipped tree, no manifest. Compile
 * the user's own skillspecs straight to `~/.claude/skills/` + `~/.kimi/skills/`,
 * apply the host-label filter, rsync script trees, and compile the user-scope
 * agent configs.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { AGENTS_MD_TARGETS, compileAgentConfig, type AgentsMdTarget } from '../../agents-md';
import {
  COMPILE_TARGETS,
  compileSkillspec,
  parseSkillspec,
  type CompileTarget,
} from '../../skillspec';
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
  SHIPPED_FILES,
  compileAgentConfigs,
  installAgentConfigSources,
  installShippedFile,
  pruneSourceMissingFileEntries,
  sourceMissingFileRows,
  type FileInstallOutcome,
  type ShippedFile,
} from './files';
import {
  NOUN_FLAGS,
  SOURCE_RELPATH,
  TARGET_RELPATHS,
  readShippedSkills,
  resolveDest,
  type ShippedSkill,
} from './skills-shipped';
import { compileAllSkillspecs, rmTreeIfPresent } from './skills-compile';
import { pruneSourceMissingSkillEntries } from './skills-manifest';
import {
  hostAllowed,
  readHostLabel,
  readUserAgentCommon,
  readUserAgentFragment,
  readUserScripts,
  readUserSkills,
  userAgentConfigOutput,
  userAgentConfigRoot,
  userScriptSourceRoot,
  userScriptTargetRoot,
  userSourceRoot,
  userTargetRoot,
  writeKimiGlobalAgent,
  type UserAgentConfigsReport,
  type UserScriptsReport,
} from './skills-user-fs';

export interface InstallReport {
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

export interface UserInstallReport {
  source: string;
  outputs: Record<CompileTarget, string>;
  hostLabel: string | null;
  skipped: { skill: string; hosts: string[] }[];
  compiled: { skill: string; target: CompileTarget; relPath: string }[];
  scripts: UserScriptsReport;
  agentConfigs: UserAgentConfigsReport;
}

export async function installRepo(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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

  // Pass 2a: compile every skillspec on disk (not just the selected slice;
  // the user may have skills installed from a previous run, and stale
  // compiled outputs left behind by a partial run would be confusing).
  const compileResult = await compileAllSkillspecs({
    dest,
    sourceRoot,
    shipped,
    shippedVersion,
    dryRun,
  });
  report.compiled = compileResult.compiled;

  // Pass 1c: copy agent-config sources. `common.md` goes through the
  // region-aware install path so a user-customised `## Specifics` survives;
  // the per-agent fragments (`claude.md`, `kimi.md`) overwrite in full.
  const agentInstall = await installAgentConfigSources({
    dest,
    shippedVersion,
    force,
    showDiff,
    dryRun,
    manifest,
  });
  report.agentConfigsCopied = agentInstall.copied;
  if (agentInstall.commonOutcome) recordFileOutcome(report, agentInstall.commonOutcome);

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
      // Single pass over source: pick the first shippedVersion seen and emit
      // one row per file. Previously two passes (values → keys).
      let version: string | undefined;
      for (const [relPath, fileEntry] of Object.entries(entry.source)) {
        version ??= fileEntry.shippedVersion;
        report.sourceMissing.push({
          skill: name,
          relPath,
          shippedVersion: version,
        });
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

export async function installUserSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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
    agentConfigs: {
      source: userAgentConfigRoot(),
      outputs: {
        claude: userAgentConfigOutput('claude'),
        kimi: userAgentConfigOutput('kimi'),
      },
      compiled: [],
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

  // Agent configs: compile `~/.config/agents/agents/{common,claude,kimi}.md`.
  // - Claude: write the full compiled markdown to `~/.claude/CLAUDE.md`.
  // - Kimi: embed the compiled content into `~/.kimi/global-agent.yaml`'s
  //   `agent.system_prompt_args.ROLE_ADDITIONAL` field (read-modify-write,
  //   preserving other yaml fields). Kimi reads that file when launched with
  //   `--agent-file ~/.kimi/global-agent.yaml`.
  // Sources silently absent → no compile, no error. Outputs are always
  // regenerated (no manifest, no refuse-on-edit).
  const agentCommon = await readUserAgentCommon();
  if (agentCommon !== null) {
    for (const target of AGENTS_MD_TARGETS) {
      const fragment = await readUserAgentFragment(target);
      const compiled = compileAgentConfig(agentCommon, fragment, target, {
        sourceDescription: userAgentConfigRoot(),
      });
      const outputPath = userAgentConfigOutput(target);
      if (!dryRun) {
        if (target === 'claude') {
          await writeFileMkdir(outputPath, Buffer.from(compiled, 'utf8'));
        } else {
          await writeKimiGlobalAgent(outputPath, compiled);
        }
      }
      report.agentConfigs.compiled.push({ target, path: outputPath });
    }
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
    const byCategory = new Map<'agents' | 'claude', number>();
    for (const s of report.scripts.installed) {
      byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
    }
    const parts = (['agents', 'claude'] as const)
      .filter((c) => byCategory.has(c))
      .map((c) => `${c}=${byCategory.get(c)}`);
    lines.push(
      `Scripts installed → ${report.scripts.targets.agents}, ${report.scripts.targets.claude} (${parts.join(', ')})`,
    );
  }
  if (report.agentConfigs.compiled.length > 0) {
    lines.push(`Agent configs compiled (${report.agentConfigs.compiled.length}):`);
    for (const c of report.agentConfigs.compiled) {
      lines.push(`  → ${c.path}  (${c.target})`);
    }
  }
  return lines.join('\n') + '\n';
}
