import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBlocksDoc } from '../../shared/plan-blocks/blocks-doc';

/**
 * Drift guards for the plan skills' shipped references:
 *
 *  - `blocks.md` in BOTH skills is exactly `renderBlocksDoc()` output, so the
 *    registry (parser + viewer + CLI) and the authored skill text can never
 *    disagree about the vocabulary. Regenerate with
 *    `condash plans blocks > conception-template/.agents/skills/<skill>/blocks.md`.
 *  - `wireframe.md` is shared word for word between the two skills, mirroring
 *    the upstream shared-core discipline.
 */
describe('plan skills shipped references', () => {
  // Repo-relative, same as skills.test.ts — locateShippedSkillsRoot() keys
  // off the built CLI's __dirname, which doesn't exist under vitest.
  const skillsRoot = resolve(__dirname, '..', '..', '..', 'conception-template', '.agents/skills');

  it('blocks.md matches the registry-generated document in both skills', async () => {
    const generated = renderBlocksDoc();
    for (const skill of ['visual-plan', 'visual-recap']) {
      const shipped = await fs.readFile(join(skillsRoot, skill, 'blocks.md'), 'utf8');
      expect(shipped.trim(), `${skill}/blocks.md drifted from the registry`).toBe(generated.trim());
    }
  });

  it('wireframe.md is identical between visual-plan and visual-recap', async () => {
    const plan = await fs.readFile(join(skillsRoot, 'visual-plan', 'wireframe.md'), 'utf8');
    const recap = await fs.readFile(join(skillsRoot, 'visual-recap', 'wireframe.md'), 'utf8');
    expect(recap).toBe(plan);
  });
});
