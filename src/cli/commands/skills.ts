/**
 * `condash skills <list|install|status>`
 *
 * Distributes the skills shipped under `conception-template/.claude/skills/`
 * into a target directory's `./.claude/skills/`. The reason this needs more
 * thought than `cp -r`:
 *
 * 1. Users edit installed skills locally. We MUST NOT silently overwrite
 *    those edits.
 * 2. Newer condash versions ship newer skills. We DO want to push those out
 *    on re-install — but only when the user hasn't edited the file since
 *    the previous install.
 *
 * Tracking is handled by a sidecar manifest at
 * `<dest>/.claude/skills/.condash-skills.json` that records, per file, the
 * SHA256 we wrote at install time + the condash version we shipped from.
 * On re-install we re-hash the on-disk file and compare:
 *
 *   - hash matches manifest → unchanged since last install → safe to update.
 *   - hash differs from manifest → user edited → refuse without --force.
 *   - file present but skill not in manifest → orphan → treat as edited.
 *
 * `--diff` shows a unified diff against the about-to-be-written content
 * before refusing. `--dest <path>` retargets the install dir (default:
 * `<conception-root or cwd>/.claude/skills/`).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import type { ParsedArgs } from '../parser';

const MANIFEST_RELPATH = '.condash-skills.json';
const MANIFEST_VERSION = 1;

interface ManifestFileEntry {
  /** SHA256 of the file content as we wrote it at last install. */
  sha256: string;
  /** condash version that shipped this content. */
  shippedVersion: string;
}

interface ManifestSkillEntry {
  files: Record<string, ManifestFileEntry>;
}

interface SkillsManifest {
  version: number;
  skills: Record<string, ManifestSkillEntry>;
}

interface ShippedSkill {
  name: string;
  /** Absolute source dir under conception-template/.claude/skills/<name>/. */
  sourceDir: string;
  /** Files relative to sourceDir, recursively. */
  files: string[];
  /** Description from SKILL.md frontmatter, if parseable. */
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
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown skills verb: ${verb}`);
  }
}

async function listShipped(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const shipped = await readShippedSkills();
  const dest = await resolveDest(args).catch(() => null);
  const manifest = dest ? await readManifest(dest) : null;
  const rows = shipped.map((s) => {
    const installedFiles = manifest?.skills[s.name]?.files;
    return {
      name: s.name,
      description: s.description,
      shippedFiles: s.files.length,
      installed: installedFiles ? Object.keys(installedFiles).length : 0,
    };
  });
  emit(ctx, { destination: dest, skills: rows }, (data) => {
    const d = data as { destination: string | null; skills: typeof rows };
    const lines: string[] = [];
    if (d.destination) lines.push(`Destination: ${d.destination}/.claude/skills/`);
    for (const r of d.skills) {
      const status =
        r.installed > 0 ? `${r.installed}/${r.shippedFiles} files installed` : 'not installed';
      lines.push(`  ${r.name.padEnd(16)} ${status.padEnd(28)} ${r.description ?? ''}`);
    }
    return lines.join('\n') + '\n';
  });
}

interface InstallReport {
  destination: string;
  copied: { skill: string; relPath: string }[];
  updated: { skill: string; relPath: string }[];
  unchanged: { skill: string; relPath: string }[];
  refused: { skill: string; relPath: string; reason: string }[];
  forced: { skill: string; relPath: string }[];
  diffs?: { skill: string; relPath: string; diff: string }[];
}

async function installSkills(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const shipped = await readShippedSkills();
  const requestedNames = args.positional.length > 0 ? args.positional : null;
  const selected = requestedNames
    ? shipped.filter((s) => {
        if (!requestedNames.includes(s.name)) return false;
        return true;
      })
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
  const skillsRoot = join(dest, '.claude', 'skills');
  await fs.mkdir(skillsRoot, { recursive: true });

  const force = args.flags.force === true;
  const showDiff = args.flags.diff === true;
  const dryRun = args.flags['dry-run'] === true;
  const shippedVersion = process.env.CONDASH_CLI_VERSION ?? 'dev';

  const manifest = (await readManifest(dest)) ?? { version: MANIFEST_VERSION, skills: {} };
  const report: InstallReport = {
    destination: skillsRoot,
    copied: [],
    updated: [],
    unchanged: [],
    refused: [],
    forced: [],
    diffs: showDiff ? [] : undefined,
  };

  for (const skill of selected) {
    if (!manifest.skills[skill.name]) {
      manifest.skills[skill.name] = { files: {} };
    }
    const skillManifest = manifest.skills[skill.name];

    for (const relPath of skill.files) {
      const sourcePath = join(skill.sourceDir, relPath);
      const sourceContent = await fs.readFile(sourcePath);
      const sourceHash = sha256(sourceContent);
      const targetPath = join(skillsRoot, skill.name, relPath);

      let onDisk: Buffer | null = null;
      try {
        onDisk = await fs.readFile(targetPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      if (onDisk === null) {
        if (!dryRun) await writeFileMkdir(targetPath, sourceContent);
        skillManifest.files[relPath] = { sha256: sourceHash, shippedVersion };
        report.copied.push({ skill: skill.name, relPath });
        continue;
      }

      const onDiskHash = sha256(onDisk);
      if (onDiskHash === sourceHash) {
        report.unchanged.push({ skill: skill.name, relPath });
        // Refresh the manifest entry so the shippedVersion reflects today's
        // install — important for tracking which condash version a user is
        // converged on, even when nothing actually changed.
        skillManifest.files[relPath] = { sha256: sourceHash, shippedVersion };
        continue;
      }

      const tracked = skillManifest.files[relPath];
      if (tracked && tracked.sha256 === onDiskHash) {
        // User hasn't edited; safe to push the new shipped content.
        if (!dryRun) await writeFileMkdir(targetPath, sourceContent);
        skillManifest.files[relPath] = { sha256: sourceHash, shippedVersion };
        report.updated.push({ skill: skill.name, relPath });
        continue;
      }

      // User-edited (or untracked-but-present). Refuse without --force.
      if (showDiff) {
        report.diffs!.push({
          skill: skill.name,
          relPath,
          diff: cheapDiff(onDisk.toString('utf8'), sourceContent.toString('utf8')),
        });
      }
      if (force) {
        if (!dryRun) await writeFileMkdir(targetPath, sourceContent);
        skillManifest.files[relPath] = { sha256: sourceHash, shippedVersion };
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

  if (!dryRun) {
    await writeManifest(dest, manifest);
  }

  // Skill-level reporting: refusals are not a hard error (user can re-run with
  // --force or --diff). But surface a non-zero exit only when --force was NOT
  // requested AND there were refusals — that way scripts can branch on it.
  emit(ctx, report, formatInstallHuman);
  if (report.refused.length > 0 && !force) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `${report.refused.length} file(s) refused (locally edited). Re-run with --force to overwrite or --diff to inspect.`,
      { refused: report.refused },
    );
  }
}

function formatInstallHuman(report: InstallReport): string {
  const lines: string[] = [];
  lines.push(`Destination: ${report.destination}`);
  if (report.copied.length > 0) {
    lines.push(`Copied (${report.copied.length}):`);
    for (const f of report.copied) lines.push(`  + ${f.skill}/${f.relPath}`);
  }
  if (report.updated.length > 0) {
    lines.push(`Updated (${report.updated.length}):`);
    for (const f of report.updated) lines.push(`  ↻ ${f.skill}/${f.relPath}`);
  }
  if (report.unchanged.length > 0) {
    lines.push(`Unchanged: ${report.unchanged.length}`);
  }
  if (report.forced.length > 0) {
    lines.push(`Forced overwrite (${report.forced.length}):`);
    for (const f of report.forced) lines.push(`  ! ${f.skill}/${f.relPath}`);
  }
  if (report.refused.length > 0) {
    lines.push(`Refused (${report.refused.length}):`);
    for (const f of report.refused) {
      lines.push(`  × ${f.skill}/${f.relPath}  (${f.reason})`);
    }
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
  const skillsRoot = join(dest, '.claude', 'skills');
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
    for (const [relPath, entry] of Object.entries(skillEntry.files)) {
      const onDiskPath = join(skillsRoot, skillName, relPath);
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
      // Local matches manifest. Compare against currently-shipped to detect
      // an update available.
      const shippedFile = ship?.files.includes(relPath)
        ? await fs.readFile(join(ship!.sourceDir, relPath))
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

  // Orphans: files under skillsRoot that aren't tracked.
  for (const skill of shipped) {
    const skillManifest = manifest.skills[skill.name]?.files ?? {};
    for (const relPath of skill.files) {
      const onDiskPath = join(skillsRoot, skill.name, relPath);
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

  emit(ctx, { destination: skillsRoot, items: report }, (data) => {
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
  });
}

async function resolveDest(args: ParsedArgs): Promise<string> {
  const explicit = args.flags.dest;
  if (typeof explicit === 'string') {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  }
  // Default: conception root if resolvable, else cwd. Skills are repo-level
  // files; conception-root is typically what the user means.
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
      `Could not read shipped skills directory at ${root}: ${(err as Error).message}`,
    );
  }
  const out: ShippedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourceDir = join(root, entry.name);
    const files = await collectFilesRelative(sourceDir);
    const description = await extractDescription(join(sourceDir, 'SKILL.md')).catch(() => null);
    out.push({ name: entry.name, sourceDir, files, description });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function locateShippedSkillsRoot(): string {
  // Override hatch primarily for tests / installs from non-standard layouts.
  const override = process.env.CONDASH_TEMPLATE_ROOT;
  if (override) return join(override, '.claude', 'skills');
  // Bundle lives at <repo>/dist-cli/condash.cjs. Walk up one to find the
  // package root, then into conception-template/.claude/skills/. Same
  // relative path holds under `npm install -g`.
  return join(__dirname, '..', 'conception-template', '.claude', 'skills');
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

async function extractDescription(skillMdPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(skillMdPath, 'utf8');
    const match = raw.match(/^---\s*$([\s\S]*?)^---\s*$/m);
    if (!match) return null;
    const desc = match[1].match(/^description:\s*(.+?)\s*$/m);
    if (!desc) return null;
    let value = desc[1].trim();
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

async function readManifest(dest: string): Promise<SkillsManifest | null> {
  const path = join(dest, '.claude', 'skills', MANIFEST_RELPATH);
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SkillsManifest;
    if (parsed.version !== MANIFEST_VERSION) {
      throw new CliError(
        ExitCodes.RUNTIME,
        `Manifest at ${path} has unknown version ${parsed.version} (expected ${MANIFEST_VERSION})`,
      );
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof CliError) throw err;
    throw new CliError(
      ExitCodes.RUNTIME,
      `Could not read manifest at ${path}: ${(err as Error).message}`,
    );
  }
}

async function writeManifest(dest: string, manifest: SkillsManifest): Promise<void> {
  const path = join(dest, '.claude', 'skills', MANIFEST_RELPATH);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function writeFileMkdir(path: string, content: Buffer): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, path);
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Cheap unified-style diff sufficient for human inspection. Real diff libs
 * (jsdiff) would balloon the bundle for marginal value here — `--diff` is
 * an inspection aid, not a merge tool.
 */
function cheapDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }
  return out.join('\n');
}

// Quiet "import only used in types" lint by referencing the imports we need.
export type { SkillsManifest };
void relative;
