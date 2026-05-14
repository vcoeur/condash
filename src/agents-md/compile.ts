/**
 * Compile a unified `AGENTS.md` source into per-agent flavours.
 *
 * The source is plain Markdown with two extensions:
 *
 *   1. **Target-tagged sections.** A heading `### Claude` (or `### Kimi`)
 *      starts a section that's kept for the matching target and stripped
 *      for the other. The section ends at the next sibling `### ` heading
 *      OR any heading of equal-or-higher level (`## `, `# `). The blank
 *      lines surrounding the heading are also collapsed so the stripped
 *      output reads cleanly.
 *
 *   2. **Variable substitution.** `{{ var }}` tokens (whitespace around the
 *      name is tolerated) are replaced from the per-target variable map.
 *      If a key isn't in the map for the current target, the token is
 *      replaced with the empty string.
 *
 * Output:
 *
 *   - Claude target → contents intended for `<conception>/.claude/CLAUDE.md`
 *   - Kimi target   → contents intended for `<conception>/.kimi/AGENTS.md`
 *
 * The compiler is intentionally minimal: no full Markdown AST, just a
 * line-based scan of `### ` and `## `/`# ` headings. This keeps it cheap
 * and predictable, and matches how authors actually structure these docs.
 */

export type AgentsMdTarget = 'claude' | 'kimi';

export const AGENTS_MD_TARGETS: readonly AgentsMdTarget[] = ['claude', 'kimi'] as const;

/** Heading text that introduces a target-tagged H3 section. */
const TARGET_HEADINGS: Record<AgentsMdTarget, string> = {
  claude: 'Claude',
  kimi: 'Kimi',
};

/** Default variable map per target, applied via `{{ var }}` substitution. */
export function defaultVariables(target: AgentsMdTarget): Record<string, string> {
  switch (target) {
    case 'claude':
      return {
        agent_name: 'Claude',
        skills_dir: '.claude/skills/',
        agent_config: 'CLAUDE.md',
        memory_dir: '~/.claude/projects/<encoded-path>/memory/',
      };
    case 'kimi':
      return {
        agent_name: 'Kimi',
        skills_dir: '.kimi/skills/',
        agent_config: 'AGENTS.md',
        // No native memory in Kimi — substitute empty.
        memory_dir: '',
      };
  }
}

export interface CompileAgentsMdOptions {
  /** Override / extend the default variable map for this target. */
  variables?: Record<string, string>;
}

export function compileAgentsMd(
  source: string,
  target: AgentsMdTarget,
  opts: CompileAgentsMdOptions = {},
): string {
  const variables = { ...defaultVariables(target), ...(opts.variables ?? {}) };
  const stripped = stripOffTargetSections(source, target);
  return substituteVariables(stripped, variables);
}

/**
 * Walk the source line by line. When a `### <off-target>` heading is hit,
 * skip every following line until the next heading of equal-or-higher level
 * (`### `, `## `, `# `) or end-of-file. Drop the surrounding blank lines
 * so the output reads cleanly.
 */
function stripOffTargetSections(source: string, keepTarget: AgentsMdTarget): string {
  const offTargets = AGENTS_MD_TARGETS.filter((t) => t !== keepTarget);
  const offHeadings = new Set(offTargets.map((t) => TARGET_HEADINGS[t]));

  const lines = source.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h3 = line.match(/^### +(.+?)\s*$/);
    if (h3 && offHeadings.has(h3[1].trim())) {
      // Eat preceding blank lines we already pushed (so the strip leaves no
      // double blank).
      while (out.length > 0 && out[out.length - 1] === '') out.pop();
      // Skip the heading and everything until the next sibling/parent heading.
      i += 1;
      while (i < lines.length) {
        const probe = lines[i];
        if (/^#{1,3} +/.test(probe)) break;
        i += 1;
      }
      // Eat trailing blank lines before the next heading so we don't end up
      // with a double-blank seam.
      while (i < lines.length && lines[i] === '') i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function substituteVariables(content: string, variables: Record<string, string>): string {
  return content.replace(VARIABLE_RE, (_, name: string) => {
    const value = variables[name];
    return value === undefined ? '' : value;
  });
}
