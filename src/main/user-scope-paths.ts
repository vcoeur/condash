import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillTab } from '../shared/types';

/**
 * User-scope (per-machine, "global") filesystem roots the Skills pane reads
 * when the scope toggle is set to `global`. These mirror the path resolvers in
 * `src/cli/commands/skills-user-fs.ts` (identical env-override names, so the
 * same fixtures drive both), kept as a small `node:`-only module so the main
 * process and the bounds checker can resolve them without importing the CLI
 * command layer. The global scope is read-only here — the CLI owns writing.
 *
 * Env overrides (used by tests):
 *   CONDASH_USER_SKILLS_ROOT          ~/.config/agents/skills   (generic specs)
 *   CONDASH_USER_CLAUDE_ROOT          ~/.claude/skills
 *   CONDASH_USER_KIMI_ROOT            ~/.kimi/skills
 *   CONDASH_USER_OPENCODE_ROOT        ~/.config/opencode/skills
 *   CONDASH_USER_AGENT_CONFIG_ROOT    ~/.config/agents/agents   (common.md + <model>.md)
 *   CONDASH_USER_CLAUDE_AGENT_OUTPUT  ~/.claude/CLAUDE.md
 *   CONDASH_USER_KIMI_AGENT_OUTPUT    ~/.kimi/AGENTS.md
 *   CONDASH_USER_OPENCODE_AGENT_OUTPUT ~/.config/opencode/AGENTS.md
 */

/** Root of the user-scope skills tree for a tab. */
export function userSkillsRoot(tab: SkillTab): string {
  switch (tab) {
    case 'generic':
      return process.env.CONDASH_USER_SKILLS_ROOT ?? join(homedir(), '.config', 'agents', 'skills');
    case 'claude':
      return process.env.CONDASH_USER_CLAUDE_ROOT ?? join(homedir(), '.claude', 'skills');
    case 'kimi':
      return process.env.CONDASH_USER_KIMI_ROOT ?? join(homedir(), '.kimi', 'skills');
    case 'opencode':
      return (
        process.env.CONDASH_USER_OPENCODE_ROOT ?? join(homedir(), '.config', 'opencode', 'skills')
      );
  }
}

/** Directory holding the user-scope agent-config sources (`common.md`,
 *  `claude.md`, `kimi.md`, `opencode.md`). Surfaced on the Generic tab. */
export function userAgentConfigRoot(): string {
  return (
    process.env.CONDASH_USER_AGENT_CONFIG_ROOT ?? join(homedir(), '.config', 'agents', 'agents')
  );
}

/** Compiled agent-config output for a per-model tab (none for `generic`). */
export function userAgentConfigOutput(tab: Exclude<SkillTab, 'generic'>): string {
  switch (tab) {
    case 'claude':
      return (
        process.env.CONDASH_USER_CLAUDE_AGENT_OUTPUT ?? join(homedir(), '.claude', 'CLAUDE.md')
      );
    case 'kimi':
      // Kimi's compiled global config is plain markdown; the kimi agent
      // launcher wraps it into a transient --agent-file at spawn.
      return process.env.CONDASH_USER_KIMI_AGENT_OUTPUT ?? join(homedir(), '.kimi', 'AGENTS.md');
    case 'opencode':
      return (
        process.env.CONDASH_USER_OPENCODE_AGENT_OUTPUT ??
        join(homedir(), '.config', 'opencode', 'AGENTS.md')
      );
  }
}

/** Directories whose subtree the Skills pane may read in global scope —
 *  the four skill roots plus the agent-config source dir. Used by the
 *  read-only bounds check; deliberately the specific roots, never their
 *  parents (keeps `~/.kimi/credentials/` etc. off-limits). */
export function userScopeReadableDirs(): string[] {
  return [
    userSkillsRoot('generic'),
    userSkillsRoot('claude'),
    userSkillsRoot('kimi'),
    userSkillsRoot('opencode'),
    userAgentConfigRoot(),
  ];
}

/** Specific files (compiled agent configs) the pane may read in global scope. */
export function userScopeReadableFiles(): string[] {
  return [
    userAgentConfigOutput('claude'),
    userAgentConfigOutput('kimi'),
    userAgentConfigOutput('opencode'),
  ];
}
