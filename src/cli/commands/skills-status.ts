/**
 * Read-only `condash skills` verbs — `list`, `status`, `validate` — for both
 * repo scope and user scope.
 *
 * All four functions are pure observation: no writes, no manifest mutation.
 * `installRepo` writes the manifest; everything here reads it.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { AGENTS_MD_TARGETS, compileAgentConfig, type AgentsMdTarget } from '../../agents-md';
import {
  COMPILE_TARGETS,
  compileSkillspec,
  parseSkillspec,
  SkillspecError,
  type CompileTarget,
} from '../../skillspec';
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
  type ScriptCategory,
} from './skills-user-fs';

// ---------------------------------------------------------------------------
// Repo-scope: list / status / validate
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// User-scope: list / status / validate
// ---------------------------------------------------------------------------

export async function listUser(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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
  const scriptsByCategory: Record<
    ScriptCategory,
    { source: string; target: string; files: string[] }
  > = {
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
  const agentCommon = await readUserAgentCommon();
  const agentConfigsList = {
    source: userAgentConfigRoot(),
    present: agentCommon !== null,
    outputs: {
      claude: userAgentConfigOutput('claude'),
      kimi: userAgentConfigOutput('kimi'),
      opencode: userAgentConfigOutput('opencode'),
    },
  };
  emit(
    ctx,
    {
      source: userSourceRoot(),
      hostLabel,
      skills: skillRows,
      scripts: scriptsByCategory,
      agentConfigs: agentConfigsList,
    },
    (data) => {
      const d = data as {
        source: string;
        hostLabel: string | null;
        skills: typeof skillRows;
        scripts: typeof scriptsByCategory;
        agentConfigs: typeof agentConfigsList;
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
      if (d.agentConfigs.present) {
        lines.push(`Agent configs: ${d.agentConfigs.source}`);
        lines.push(`  → ${d.agentConfigs.outputs.claude}  (claude)`);
        lines.push(`  → ${d.agentConfigs.outputs.kimi}  (kimi)`);
        lines.push(`  → ${d.agentConfigs.outputs.opencode}  (opencode)`);
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'skills' },
  );
}

export type UserStatusEntry =
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
    }
  | {
      kind: 'agent-config';
      target: AgentsMdTarget;
      path: string;
      state: 'ok' | 'stale' | 'missing';
    };

export async function userSkillsStatus(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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

  const agentCommon = await readUserAgentCommon();
  if (agentCommon !== null) {
    for (const target of AGENTS_MD_TARGETS) {
      const fragment = await readUserAgentFragment(target);
      const expected = compileAgentConfig(agentCommon, fragment, target, {
        sourceDescription: userAgentConfigRoot(),
      });
      const outputPath = userAgentConfigOutput(target);
      let state: 'ok' | 'stale' | 'missing';
      if (target === 'claude' || target === 'opencode') {
        // Claude (CLAUDE.md) and OpenCode (AGENTS.md) are plain markdown files.
        let onDisk: string | null = null;
        try {
          onDisk = await fs.readFile(outputPath, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        if (onDisk === null) state = 'missing';
        else if (onDisk === expected) state = 'ok';
        else state = 'stale';
      } else {
        // Kimi: parse yaml, extract ROLE_ADDITIONAL, compare.
        let yamlText: string | null = null;
        try {
          yamlText = await fs.readFile(outputPath, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        if (yamlText === null) {
          state = 'missing';
        } else {
          const parsed = parseYaml(yamlText);
          const actual = (
            parsed as { agent?: { system_prompt_args?: { ROLE_ADDITIONAL?: string } } }
          )?.agent?.system_prompt_args?.ROLE_ADDITIONAL;
          state = actual === expected ? 'ok' : 'stale';
        }
      }
      items.push({ kind: 'agent-config', target, path: outputPath, state });
    }
  }

  emit(
    ctx,
    { source: userSourceRoot(), hostLabel, items },
    (data) => {
      const d = data as { source: string; hostLabel: string | null; items: UserStatusEntry[] };
      if (d.items.length === 0) return `(nothing tracked under ${d.source})\n`;
      const skillRows = d.items.filter(
        (r): r is Extract<UserStatusEntry, { kind: 'skill' }> => r.kind === 'skill',
      );
      const scriptRows = d.items.filter(
        (r): r is Extract<UserStatusEntry, { kind: 'script' }> => r.kind === 'script',
      );
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
      const agentRows = d.items.filter(
        (r): r is Extract<UserStatusEntry, { kind: 'agent-config' }> => r.kind === 'agent-config',
      );
      if (agentRows.length > 0) {
        if (skillRows.length > 0 || scriptRows.length > 0) lines.push('');
        const widths = {
          target: 12,
          path: Math.max(4, ...agentRows.map((r) => r.path.length)),
        };
        for (const r of agentRows) {
          lines.push(
            `  ${`agent-${r.target}`.padEnd(widths.target)}  ${r.path.padEnd(widths.path)}  ${r.state}`,
          );
        }
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'items' },
  );
}

export async function validateUserSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
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
