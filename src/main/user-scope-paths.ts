import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * User-scope (per-machine, "user") filesystem roots the Skills pane reads
 * when the scope toggle is set to `user`. Post-reframe these mirror the
 * agedum source-of-truth paths verbatim — condash never reads the per-
 * harness compiled outputs (`~/.claude/`, `~/.kimi/`, …).
 *
 * Env overrides (used by tests):
 *   CONDASH_USER_SKILLS_ROOT       ~/.config/agents/skills
 *   CONDASH_USER_AGENTS_MD         ~/.config/agents/AGENTS.md
 */

/** Root of the user-scope skills tree (agedum source). */
export function userSkillsRoot(): string {
  return process.env.CONDASH_USER_SKILLS_ROOT ?? join(homedir(), '.config', 'agents', 'skills');
}

/** Path of the user-scope AGENTS.md file (agedum source). */
export function userAgentsMdPath(): string {
  return process.env.CONDASH_USER_AGENTS_MD ?? join(homedir(), '.config', 'agents', 'AGENTS.md');
}

/** Directories whose subtree the Skills pane may read in user scope.
 *  Used by the read-only bounds check. */
export function userScopeReadableDirs(): string[] {
  return [userSkillsRoot()];
}

/** Specific files the pane may read in user scope. */
export function userScopeReadableFiles(): string[] {
  return [userAgentsMdPath()];
}
