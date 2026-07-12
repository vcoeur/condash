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
});
