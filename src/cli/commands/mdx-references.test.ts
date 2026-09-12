import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBlocksDoc } from '../../shared/plan-blocks/blocks-doc';

/**
 * Drift guard for the `/visual` skill's shipped block vocabulary:
 * `visual/blocks.md` is exactly `renderBlocksDoc()` output, so the registry
 * (parser + viewer + CLI) and the authored skill text can never disagree about
 * the vocabulary. Regenerate with
 * `condash mdx blocks > conception-template/.agents/skills/visual/blocks.md`.
 */
describe('visual skill shipped references', () => {
  // Repo-relative, same as skills.test.ts — locateShippedSkillsRoot() keys
  // off the built CLI's __dirname, which doesn't exist under vitest.
  const skillsRoot = resolve(__dirname, '..', '..', '..', 'conception-template', '.agents/skills');

  it('visual/blocks.md matches the registry-generated document', async () => {
    const generated = renderBlocksDoc();
    const shipped = await fs.readFile(join(skillsRoot, 'visual', 'blocks.md'), 'utf8');
    expect(shipped.trim(), 'visual/blocks.md drifted from the registry').toBe(generated.trim());
  });

  it('states one question-form policy across the skill prose', async () => {
    // Issue #548's approved policy, pinned where it is written down: the
    // default is ONE bottom form collecting every single or cross-cutting
    // decision; a note with independent decision sections may instead put
    // one form below each. SKILL.md and document-quality.md paraphrase the
    // same rule — if either reverts to one-form-per-document exclusivity or
    // drops the per-section allowance, the two files (and the policy) drift.
    const read = async (name: string): Promise<string> => {
      const raw = await fs.readFile(join(skillsRoot, 'visual', name), 'utf8');
      return raw.replace(/\s+/g, ' ');
    };
    const skill = await read('SKILL.md');
    const quality = await read('document-quality.md');

    for (const [name, text] of [
      ['SKILL.md', skill],
      ['document-quality.md', quality],
    ] as const) {
      expect(text, `${name}: lost the one-bottom-form default`).toContain(
        'one bottom form collecting every single or cross-cutting decision',
      );
      expect(text, `${name}: lost the per-decision-section allowance`).toContain(
        'one `question-form` below each decision section',
      );
      expect(text, `${name}: back to one-form-per-document exclusivity`).not.toContain(
        'ONE bottom',
      );
      expect(text, `${name}: back to only-place exclusivity`).not.toContain(
        'the only place that enumerates',
      );
    }

    // The registry description is what makes per-section forms safe — one
    // Save writes every form in the document — and blocks.md is its
    // drift-pinned render.
    expect(await read('blocks.md')).toContain('every form in the document');
  });
});
