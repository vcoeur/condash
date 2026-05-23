/**
 * Foundation module for user-scope `condash skills` (`--user`): path
 * resolvers, source-tree readers, the host-label filter, and the Kimi
 * global-agent.yaml inline writer.
 *
 * In user scope there is no shipped tree and no manifest: the user owns the
 * source tree at `~/.config/agents/skills/<name>/` directly. The compile
 * pipeline is the same one as repo scope (`parseSkillspec` +
 * `compileSkillspec`), pointed at different roots, and the outputs land in
 * `~/.claude/skills/` and `~/.kimi/skills/`. Outputs are always regenerated
 * (no refuse-on-edit — the user knows the outputs are derived).
 *
 * The `hosts:` field on a spec.yaml restricts a skill to a list of host
 * labels (e.g. `hosts: [vcoeur]`). When present, condash reads the host
 * label from `~/.claude/.host` (single line, whitespace-stripped) and
 * skips skills whose `hosts:` does not contain the current label. This
 * is the multi-host filter previously enforced by agentsconf's
 * `/sync-config`; moving it here lets a single source-of-truth feed all
 * hosts without per-host pruning at sync time.
 *
 * Paths are env-overridable for tests:
 *   CONDASH_USER_SKILLS_ROOT  — replaces ~/.config/agents/skills
 *   CONDASH_USER_CLAUDE_ROOT  — replaces ~/.claude/skills
 *   CONDASH_USER_KIMI_ROOT    — replaces ~/.kimi/skills
 *   CONDASH_USER_HOST_FILE    — replaces ~/.claude/.host
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, ExitCodes } from '../output';
import { parseSkillspec, type CompileTarget } from '../../skillspec';
import type { AgentsMdTarget } from '../../agents-md';
import { collectFilesRelative, extractDescriptionFromSpec } from './skills-shipped';

export interface UserSkill {
  name: string;
  sourceDir: string;
  files: string[];
  description: string | null;
  /** Parsed `hosts:` list from spec.yaml; null if the field is absent. */
  hosts: string[] | null;
}

export type ScriptCategory = 'agents' | 'claude';

export interface UserScript {
  category: ScriptCategory;
  source: string;
  target: string;
  relPath: string;
}

export interface UserScriptsReport {
  sources: Record<ScriptCategory, string>;
  targets: Record<ScriptCategory, string>;
  installed: { category: ScriptCategory; relPath: string }[];
}

export interface UserAgentConfigsReport {
  source: string;
  outputs: Record<AgentsMdTarget, string>;
  compiled: { target: AgentsMdTarget; path: string }[];
}

export function userSourceRoot(): string {
  return process.env.CONDASH_USER_SKILLS_ROOT ?? join(homedir(), '.config', 'agents', 'skills');
}

export function userTargetRoot(target: CompileTarget): string {
  // OpenCode reads user skills from the XDG config dir, not `~/.opencode/skills`.
  if (target === 'opencode') {
    return (
      process.env.CONDASH_USER_OPENCODE_ROOT ?? join(homedir(), '.config', 'opencode', 'skills')
    );
  }
  const envName = target === 'claude' ? 'CONDASH_USER_CLAUDE_ROOT' : 'CONDASH_USER_KIMI_ROOT';
  return process.env[envName] ?? join(homedir(), `.${target}`, 'skills');
}

export function userScriptSourceRoot(category: ScriptCategory): string {
  if (category === 'agents') {
    return (
      process.env.CONDASH_USER_AGENTS_SCRIPTS_ROOT ??
      join(homedir(), '.config', 'agents', 'agents-scripts')
    );
  }
  return (
    process.env.CONDASH_USER_CLAUDE_SCRIPTS_ROOT ??
    join(homedir(), '.config', 'agents', 'claude-scripts')
  );
}

export function userScriptTargetRoot(category: ScriptCategory): string {
  if (category === 'agents') {
    return (
      process.env.CONDASH_USER_AGENTS_SCRIPTS_TARGET ??
      join(homedir(), '.config', 'agents', 'scripts')
    );
  }
  return process.env.CONDASH_USER_CLAUDE_SCRIPTS_TARGET ?? join(homedir(), '.claude', 'scripts');
}

export function userAgentConfigRoot(): string {
  return (
    process.env.CONDASH_USER_AGENT_CONFIG_ROOT ?? join(homedir(), '.config', 'agents', 'agents')
  );
}

export function userAgentConfigOutput(target: AgentsMdTarget): string {
  if (target === 'claude') {
    return process.env.CONDASH_USER_CLAUDE_AGENT_OUTPUT ?? join(homedir(), '.claude', 'CLAUDE.md');
  }
  if (target === 'opencode') {
    // OpenCode reads global rules from ~/.config/opencode/AGENTS.md.
    return (
      process.env.CONDASH_USER_OPENCODE_AGENT_OUTPUT ??
      join(homedir(), '.config', 'opencode', 'AGENTS.md')
    );
  }
  // Kimi: a plain instructions markdown. The kimi agent launcher wraps it into
  // a transient `--agent-file` (ROLE_ADDITIONAL) at spawn — no baked YAML.
  return process.env.CONDASH_USER_KIMI_AGENT_OUTPUT ?? join(homedir(), '.kimi', 'AGENTS.md');
}

export function userHostFile(): string {
  return process.env.CONDASH_USER_HOST_FILE ?? join(homedir(), '.claude', '.host');
}

/** Read `common.md` from the user-scope agent-config source. Returns null if absent. */
export async function readUserAgentCommon(): Promise<string | null> {
  try {
    return await fs.readFile(join(userAgentConfigRoot(), 'common.md'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Read a per-agent fragment (claude.md or kimi.md). Returns empty string if missing. */
export async function readUserAgentFragment(target: AgentsMdTarget): Promise<string> {
  try {
    return await fs.readFile(join(userAgentConfigRoot(), `${target}.md`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function readUserScripts(): Promise<UserScript[]> {
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

export async function readHostLabel(): Promise<string | null> {
  try {
    const raw = await fs.readFile(userHostFile(), 'utf8');
    const label = raw.trim();
    return label.length > 0 ? label : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Coerce a spec.yaml `hosts:` value to a string list, or null if the field
 * is absent. Accepts a YAML list (`[vcoeur, oomade]`) or a single scalar
 * treated as a one-element list.
 */
export function normalizeHosts(value: unknown): string[] | null {
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

export async function readUserSkills(): Promise<UserSkill[]> {
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

export function hostAllowed(skill: UserSkill, hostLabel: string | null): boolean {
  if (skill.hosts === null) return true;
  if (skill.hosts.length === 0) return true;
  if (hostLabel === null) return false;
  return skill.hosts.includes(hostLabel);
}
