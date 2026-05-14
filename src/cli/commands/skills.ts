/**
 * `condash skills <list|install|status|validate>`
 *
 * As of v2.29.0 condash ships **skillspecs** rather than flat Claude-format
 * `SKILL.md` files. A skillspec is an agent-neutral source directory
 * (`spec.yaml` + `body.md` + optional `targets/<claude|kimi>.yaml` overlays
 * + arbitrary sibling assets); the compiler in `src/skillspec/` turns each
 * spec into agent-native skill files for Claude (`.claude/skills/`) and
 * Kimi (`.kimi/skills/`).
 *
 * Install model:
 *
 *   Pass 1 — copy each shipped skillspec source file into the conception's
 *   `<dest>/.agents/skills/<name>/<relpath>`. This uses the existing SHA-
 *   tracked manifest (`<dest>/.claude/skills/.condash-skills.json`) with
 *   refuse-on-edit semantics: if the user edited a source file, we refuse
 *   to overwrite without `--force` or `--diff`.
 *
 *   Pass 2 — parse each (now-on-disk) skillspec and compile it for each
 *   target (`claude`, `kimi`), writing compiled `SKILL.md` + sibling assets
 *   into `<dest>/.claude/skills/<name>/` and `<dest>/.kimi/skills/<name>/`.
 *   Compiled outputs are deterministic from sources and are always
 *   regenerated; they are **not** tracked by the manifest.
 *
 *   Conventionally the conception's `.gitignore` excludes `/.claude/skills/`
 *   and `/.kimi/skills/` (templates regenerated on every install) but
 *   tracks `/.agents/skills/` (the source-of-truth).
 *
 * `--dest <path>` retargets the install dir (default: conception root or
 * cwd). `--force` overrides refuse-on-edit. `--diff` shows a unified diff
 * for each refused source file. `--dry-run` reports what would be written
 * without touching disk.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import {
  COMPILE_TARGETS,
  compileSkillspec,
  parseSkillspec,
  SkillspecError,
  type CompileTarget,
} from '../../skillspec';
import {
  MANIFEST_VERSION,
  cheapDiff,
  readManifest,
  sha256,
  writeFileMkdir,
  writeManifest,
} from './install-shared';

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
): Promise<void> {
  switch (verb) {
    case null:
    case 'list':
      return await listShipped(args, ctx);
    case 'install':
      return await installSkills(args, ctx);
    case 'status':
      return await skillsStatus(args, ctx);
    case 'validate':
      return await validateSkills(args, ctx);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown skills verb: ${verb}`);
  }
}

async function listShipped(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const shipped = await readShippedSkills();
  const dest = await resolveDest(args).catch(() => null);
  delete args.flags.dest;
  assertNoExtraFlags(args);
  const manifest = dest ? await readManifest(dest) : null;
  const rows = shipped.map((s) => {
    const installedFiles = manifest?.skills[s.name]?.source;
    return {
      name: s.name,
      description: s.description,
      shippedFiles: s.files.length,
      installed: installedFiles ? Object.keys(installedFiles).length : 0,
    };
  });
  emit(
    ctx,
    { destination: dest, skills: rows },
    (data) => {
      const d = data as { destination: string | null; skills: typeof rows };
      const lines: string[] = [];
      if (d.destination) lines.push(`Destination: ${d.destination}/${SOURCE_RELPATH}/`);
      for (const r of d.skills) {
        const status =
          r.installed > 0 ? `${r.installed}/${r.shippedFiles} files installed` : 'not installed';
        lines.push(`  ${r.name.padEnd(16)} ${status.padEnd(28)} ${r.description ?? ''}`);
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'skills' },
  );
}

interface InstallReport {
  destination: string;
  /** Compiled-output root paths, by target. */
  outputs: Record<CompileTarget, string>;
  copied: { skill: string; relPath: string }[];
  updated: { skill: string; relPath: string }[];
  unchanged: { skill: string; relPath: string }[];
  refused: { skill: string; relPath: string; reason: string }[];
  forced: { skill: string; relPath: string }[];
  /** Compiled outputs written in pass 2. */
  compiled: { skill: string; target: CompileTarget; relPath: string }[];
  diffs?: { skill: string; relPath: string; diff: string }[];
}

async function installSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const shipped = await readShippedSkills();
  const requestedNames = args.positional.length > 0 ? args.positional : null;
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

  const dest = await resolveDest(args);
  const sourceRoot = join(dest, SOURCE_RELPATH);
  await fs.mkdir(sourceRoot, { recursive: true });

  const force = args.flags.force === true;
  const showDiff = args.flags.diff === true;
  const dryRun = args.flags['dry-run'] === true;
  for (const k of ['dest', 'force', 'diff', 'dry-run']) delete args.flags[k];
  assertNoExtraFlags(args);
  const shippedVersion = process.env.CONDASH_CLI_VERSION ?? 'dev';

  const manifest = (await readManifest(dest)) ?? { version: MANIFEST_VERSION, skills: {} };
  const report: InstallReport = {
    destination: sourceRoot,
    outputs: {
      claude: join(dest, TARGET_RELPATHS.claude),
      kimi: join(dest, TARGET_RELPATHS.kimi),
    },
    copied: [],
    updated: [],
    unchanged: [],
    refused: [],
    forced: [],
    compiled: [],
    diffs: showDiff ? [] : undefined,
  };

  // Pass 1: copy skillspec sources with refuse-on-edit. A skill whose source
  // files are fully clean (or forced) is eligible for pass-2 compilation.
  const compileEligible: ShippedSkill[] = [];

  for (const skill of selected) {
    if (!manifest.skills[skill.name]) {
      manifest.skills[skill.name] = { source: {} };
    }
    const skillManifest = manifest.skills[skill.name];

    let blocked = false;
    for (const relPath of skill.files) {
      const sourcePath = join(skill.sourceDir, relPath);
      const sourceContent = await fs.readFile(sourcePath);
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
          skill: skill.name,
          relPath,
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
        blocked = true;
      }
    }
    if (!blocked || force) compileEligible.push(skill);
  }

  // Pass 2: compile each eligible skillspec and write outputs. Outputs are
  // always regenerated and not tracked by the manifest. On dry-run we parse
  // straight from the shipped tree (the on-disk source may not have been
  // written) so the report still reflects what would be emitted.
  for (const skill of compileEligible) {
    const parsed = await parseSkillspec(dryRun ? skill.sourceDir : join(sourceRoot, skill.name));
    for (const target of COMPILE_TARGETS) {
      const compiled = compileSkillspec(parsed, target);
      const outputRoot = join(dest, TARGET_RELPATHS[target], skill.name);
      // Wipe stale files so previously-shipped-but-now-deleted assets don't
      // linger. Skipped on dry-run.
      if (!dryRun) await rmTreeIfPresent(outputRoot);
      for (const [relPath, content] of Object.entries(compiled.files)) {
        if (!dryRun) await writeFileMkdir(join(outputRoot, relPath), content);
        report.compiled.push({ skill: skill.name, target, relPath });
      }
    }
  }

  if (!dryRun) await writeManifest(dest, manifest);

  emit(ctx, report, formatInstallHuman);
  if (report.refused.length > 0 && !force) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `${report.refused.length} file(s) refused (locally edited). Re-run with --force to overwrite or --diff to inspect.`,
      { refused: report.refused },
    );
  }
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
  if (report.diffs && report.diffs.length > 0) {
    for (const d of report.diffs) {
      lines.push('');
      lines.push(`--- diff: ${d.skill}/${d.relPath}`);
      lines.push(d.diff);
    }
  }
  return lines.join('\n') + '\n';
}

async function skillsStatus(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const dest = await resolveDest(args);
  delete args.flags.dest;
  assertNoExtraFlags(args);
  const sourceRoot = join(dest, SOURCE_RELPATH);
  const shipped = await readShippedSkills();
  const manifest = (await readManifest(dest)) ?? { version: MANIFEST_VERSION, skills: {} };
  const shippedByName = new Map(shipped.map((s) => [s.name, s]));

  const report: {
    skill: string;
    file: string;
    state: 'unchanged' | 'edited' | 'missing' | 'orphan' | 'outdated';
    shippedVersion: string | null;
  }[] = [];

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
        report.push({
          skill: skillName,
          file: relPath,
          state: 'missing',
          shippedVersion: entry.shippedVersion,
        });
        continue;
      }
      const onDiskHash = sha256(onDisk);
      if (onDiskHash !== entry.sha256) {
        report.push({
          skill: skillName,
          file: relPath,
          state: 'edited',
          shippedVersion: entry.shippedVersion,
        });
        continue;
      }
      const shippedFile = ship?.files.includes(relPath)
        ? await fs.readFile(join(ship.sourceDir, relPath))
        : null;
      if (shippedFile && sha256(shippedFile) !== entry.sha256) {
        report.push({
          skill: skillName,
          file: relPath,
          state: 'outdated',
          shippedVersion: entry.shippedVersion,
        });
      } else {
        report.push({
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
        report.push({ skill: skill.name, file: relPath, state: 'orphan', shippedVersion: null });
      }
    }
  }

  emit(
    ctx,
    { destination: sourceRoot, items: report },
    (data) => {
      const d = data as { destination: string; items: typeof report };
      if (d.items.length === 0) return `(no installed skills under ${d.destination})\n`;
      const widths = {
        skill: Math.max(5, ...d.items.map((r) => r.skill.length)),
        file: Math.max(4, ...d.items.map((r) => r.file.length)),
        state: 9,
      };
      return (
        d.items
          .map(
            (r) =>
              `  ${r.skill.padEnd(widths.skill)}  ${r.file.padEnd(widths.file)}  ${r.state.padEnd(widths.state)}  ${r.shippedVersion ?? '-'}`,
          )
          .join('\n') + '\n'
      );
    },
    [],
    { streamField: 'items' },
  );
}

interface ValidateReport {
  source: string;
  skills: { name: string; errors: string[] }[];
}

async function validateSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const requestedNames = args.positional.length > 0 ? args.positional : null;
  delete args.flags.dest;
  assertNoExtraFlags(args);

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
