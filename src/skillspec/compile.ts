import { stringify as stringifyYaml } from 'yaml';
import type { CompileTarget, CompiledSkill, Skillspec } from './types';

/**
 * Compile a parsed skillspec for a single target. Returns the file map keyed
 * by path relative to the destination skill directory.
 *
 * Compilation is **pass-through** for frontmatter: every key in `spec` and
 * `targets[target]` lands in the compiled SKILL.md frontmatter verbatim.
 * No whitelist, no validation — Claude (and Kimi) silently ignore unknown
 * keys, and a per-format whitelist would be a moving target as the agents
 * add fields. Sibling assets are copied byte-for-byte.
 *
 * Frontmatter ordering: keys from `spec.yaml` come first in their declared
 * order (with values overridden by the overlay where keys collide); then
 * any keys present in the target overlay but not in the spec, in their
 * declared order. This produces a stable visual diff across recompiles
 * without imposing an arbitrary canonical order.
 */
export function compileSkillspec(spec: Skillspec, target: CompileTarget): CompiledSkill {
  const overlay = spec.targets[target] ?? {};
  const merged = mergeFrontmatter(spec.spec, overlay);

  const files: Record<string, Buffer> = {
    'SKILL.md': Buffer.from(renderSkillMd(merged, spec.body), 'utf8'),
  };
  for (const [relPath, content] of Object.entries(spec.assets)) {
    files[relPath] = content;
  }

  return { files };
}

function mergeFrontmatter(
  spec: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    out[k] = k in overlay ? overlay[k] : v;
  }
  for (const [k, v] of Object.entries(overlay)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function renderSkillMd(frontmatter: Record<string, unknown>, body: string): string {
  // Body normalization: strip leading blank lines, ensure single trailing newline.
  // The compiler always inserts exactly one blank line between the closing
  // `---` and the first body line, regardless of authoring whitespace.
  let normalizedBody = body.replace(/^\n+/, '');
  if (!normalizedBody.endsWith('\n')) normalizedBody += '\n';

  // `lineWidth: 0` disables YAML line folding — long values stay on one line,
  // matching the convention used by every existing shipped SKILL.md.
  const yamlBlock = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBlock}\n---\n\n${normalizedBody}`;
}
