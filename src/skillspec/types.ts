/**
 * Shared types for the skillspec compiler.
 *
 * A skillspec is an agent-neutral source directory at
 * `<conception>/.agents/skills/<name>/` (or `~/.config/agents/skills/<name>/`)
 * that compiles into agent-native skill formats:
 *
 *   - Claude   → `<conception>/.claude/skills/<name>/SKILL.md`   + sibling assets
 *   - Kimi     → `<conception>/.kimi/skills/<name>/SKILL.md`     + sibling assets
 *   - OpenCode → `<conception>/.opencode/skills/<name>/SKILL.md` + sibling assets
 *
 * Source layout:
 *
 *   <name>/
 *   ├── spec.yaml                # required — agent-neutral frontmatter
 *   │                             # (must include `description`)
 *   ├── body.md                  # required — SKILL.md body without frontmatter
 *   ├── targets/                 # optional — per-target frontmatter overlays
 *   │   ├── claude.yaml
 *   │   ├── kimi.yaml
 *   │   └── opencode.yaml
 *   └── …                        # any other file/dir is a sibling asset,
 *                                 #   copied verbatim under the same path.
 */

export type CompileTarget = 'claude' | 'kimi' | 'opencode';

export const COMPILE_TARGETS: readonly CompileTarget[] = ['claude', 'kimi', 'opencode'] as const;

/**
 * Parsed source directory. `spec` and `targets[t]` carry frontmatter as parsed
 * by the YAML library (insertion order preserved). Pass-through is the
 * philosophy — unknown keys round-trip into the compiled output.
 */
export interface Skillspec {
  /** Skill directory name = source dir basename. */
  name: string;
  /** Absolute path to source directory. */
  sourceDir: string;
  /** Parsed `spec.yaml` content. */
  spec: Record<string, unknown>;
  /** Raw `body.md` content (no frontmatter delimiters). */
  body: string;
  /** Per-target overlays parsed from `targets/<t>.yaml`. Missing keys mean no overlay. */
  targets: Partial<Record<CompileTarget, Record<string, unknown>>>;
  /**
   * Sibling assets keyed by relative path within sourceDir
   * (e.g. `close.md`, `references/cmd.md`, `scripts/foo.py`). Excludes
   * `spec.yaml`, `body.md`, and the entire `targets/` subtree. Hidden
   * files (leading dot) are skipped.
   */
  assets: Record<string, Buffer>;
}

/**
 * Output of a single-target compile. File keys are paths relative to the
 * destination skill directory.
 */
export interface CompiledSkill {
  files: Record<string, Buffer>;
}
