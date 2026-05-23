import { parse as parseYaml } from 'yaml';
import { SkillspecError } from './parse';

/** A `SKILL.md` split back into its agent-neutral parts. */
export interface DecompiledSkill {
  /** Parsed YAML frontmatter — the mapping between the leading `---` fences. */
  frontmatter: Record<string, unknown>;
  /** Markdown body after the closing `---`, with leading blank lines stripped. */
  body: string;
}

/** Matches a leading `---\n…\n---` frontmatter block (CRLF tolerant). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a compiled `SKILL.md` back into frontmatter + body — the inverse of
 * the compiler's `renderSkillMd`. condash's compile path is otherwise one-way;
 * this is the import direction, used to ingest an externally-authored
 * `SKILL.md` (e.g. from `~/.config/opencode/skills/` or `~/.hermes/skills/`)
 * into an agent-neutral skillspec source (`spec.yaml` + `body.md`).
 *
 * @param skillMd Full `SKILL.md` text (frontmatter fence + body).
 * @returns The parsed frontmatter mapping and the body markdown.
 * @throws SkillspecError if the leading `---` block is missing, empty, or not
 *   a YAML mapping.
 */
export function decompileSkillMd(skillMd: string): DecompiledSkill {
  const match = skillMd.match(FRONTMATTER_RE);
  if (!match) {
    throw new SkillspecError('SKILL.md is missing a leading `---` YAML frontmatter block');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (err) {
    throw new SkillspecError(`Failed to parse SKILL.md frontmatter: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new SkillspecError('SKILL.md frontmatter is empty');
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillspecError('SKILL.md frontmatter must be a YAML mapping');
  }

  const body = skillMd.slice(match[0].length).replace(/^\r?\n+/, '');
  return { frontmatter: parsed as Record<string, unknown>, body };
}
