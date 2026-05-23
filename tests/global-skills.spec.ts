import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end for the Skills pane's local/global scope toggle (+ refresh + the
 * Generic agent-config sources). Boots a fixture conception for the local
 * scope and a separate temp tree wired in via the `CONDASH_USER_*` overrides
 * for the global scope, then drives the two-row header.
 *
 * Vitest (`src/main/skills.test.ts`) already covers the reader logic; this
 * spec verifies the renderer ↔ IPC ↔ FS round-trip and that flipping the
 * scope actually swaps the tree. Screenshots land in
 * `tests/screenshots-out/global-skills/` for visual review (gitignored).
 */

const shotDir = resolve(__dirname, 'screenshots-out', 'global-skills');

async function shoot(window: import('@playwright/test').Page, name: string): Promise<void> {
  await mkdir(shotDir, { recursive: true });
  await window
    .locator('.skills-pane')
    .screenshot({ path: join(shotDir, `${name}.png`), timeout: 8_000 })
    .catch((err) => console.error(`[shoot] ${name}: ${(err as Error).message}`));
}

test('Skills pane: local/global scope toggle, Generic sources, refresh', async () => {
  // Global-scope fixture tree, pointed at by the CONDASH_USER_* overrides.
  const globalDir = await mkdtemp(join(tmpdir(), 'condash-global-skills-'));
  await mkdir(join(globalDir, 'g-skills', 'pr'), { recursive: true });
  await writeFile(join(globalDir, 'g-skills', 'pr', 'spec.yaml'), 'description: global pr\n', 'utf8');
  await mkdir(join(globalDir, 'g-agents'), { recursive: true });
  await writeFile(join(globalDir, 'g-agents', 'common.md'), '# Global common\n\nGlobal base.\n', 'utf8');
  await writeFile(join(globalDir, 'g-agents', 'claude.md'), '# Global claude overlay\n', 'utf8');
  await mkdir(join(globalDir, 'c-skills', 'commit'), { recursive: true });
  await writeFile(join(globalDir, 'c-skills', 'commit', 'SKILL.md'), '# Global commit\n\nx\n', 'utf8');
  await mkdir(join(globalDir, 'k-skills'), { recursive: true });
  await mkdir(join(globalDir, 'o-skills'), { recursive: true });
  await mkdir(join(globalDir, 'claude-out'), { recursive: true });
  await writeFile(join(globalDir, 'claude-out', 'CLAUDE.md'), '# Global CLAUDE\n\nGlobal rules.\n', 'utf8');

  const booted = await bootApp({
    env: {
      CONDASH_USER_SKILLS_ROOT: join(globalDir, 'g-skills'),
      CONDASH_USER_AGENT_CONFIG_ROOT: join(globalDir, 'g-agents'),
      CONDASH_USER_CLAUDE_ROOT: join(globalDir, 'c-skills'),
      CONDASH_USER_KIMI_ROOT: join(globalDir, 'k-skills'),
      CONDASH_USER_OPENCODE_ROOT: join(globalDir, 'o-skills'),
      CONDASH_USER_CLAUDE_AGENT_OUTPUT: join(globalDir, 'claude-out', 'CLAUDE.md'),
    },
    prepare: async (conceptionDir) => {
      // Local Claude skill + the conception's own CLAUDE.md.
      await mkdir(join(conceptionDir, '.claude', 'skills', 'projects'), { recursive: true });
      await writeFile(
        join(conceptionDir, '.claude', 'skills', 'projects', 'SKILL.md'),
        '# Projects skill\n\nLead.\n',
        'utf8',
      );
      await writeFile(join(conceptionDir, 'CLAUDE.md'), '# Local project CLAUDE\n\nLocal rules.\n', 'utf8');
      // Local Generic agent-config sources.
      await mkdir(join(conceptionDir, '.agents', 'agents'), { recursive: true });
      await writeFile(join(conceptionDir, '.agents', 'agents', 'common.md'), '# Local common\n\nBase.\n', 'utf8');
      await writeFile(join(conceptionDir, '.agents', 'agents', 'claude.md'), '# Local claude overlay\n', 'utf8');
      await mkdir(join(conceptionDir, '.agents', 'skills', 'foo'), { recursive: true });
      await writeFile(join(conceptionDir, '.agents', 'skills', 'foo', 'spec.yaml'), 'description: local foo\n', 'utf8');
    },
  });
  const { window, cleanup } = booted;
  try {
    await window.locator('.edge-strip-right .edge-handle').filter({ hasText: 'Skills' }).click();
    await expect(window.locator('.skills-pane')).toBeVisible();

    // Row 1 renders both scope buttons; Local is the default + active.
    const localBtn = window.locator('.skills-scope-btn', { hasText: 'Local' });
    const globalBtn = window.locator('.skills-scope-btn', { hasText: 'Global' });
    await expect(localBtn).toBeVisible();
    await expect(globalBtn).toBeVisible();
    await expect(localBtn).toHaveAttribute('aria-pressed', 'true');

    // Default Claude tab: the conception's CLAUDE.md callout, badged CLAUDE.
    await expect(
      window.locator('.tree-special-file', { hasText: 'Local project CLAUDE' }),
    ).toBeVisible();
    await expect(window.locator('.tree-special-badge', { hasText: 'CLAUDE' }).first()).toBeVisible();
    await shoot(window, 'local-claude');

    // Generic tab: common.md + every <model>.md source render as read-only
    // callouts in the config band (not as plain cards) — common.md AND
    // claude.md must both be callouts.
    await window.locator('.skills-tab', { hasText: 'Generic' }).click();
    await expect(window.locator('.tree-special-badge', { hasText: 'COMMON' })).toBeVisible();
    await expect(window.locator('.skills-config-band .tree-special-file')).toHaveCount(2);
    await expect(
      window.locator('.skills-config-band .tree-special-file', { hasText: 'Local common' }),
    ).toBeVisible();
    await expect(
      window.locator('.skills-config-band .tree-special-file', { hasText: 'Local claude overlay' }),
    ).toBeVisible();
    await shoot(window, 'local-generic');

    // Flip to Global — the tree must swap (Local common → Global common).
    await globalBtn.click();
    await expect(globalBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window.locator('.tree-special-file', { hasText: 'Global common' }),
    ).toBeVisible();
    await expect(window.locator('.tree-special-file', { hasText: 'Local common' })).toHaveCount(0);
    await shoot(window, 'global-generic');

    // Global Claude tab: the compiled ~/.claude/CLAUDE.md + the global skill.
    await window.locator('.skills-tab', { hasText: 'Claude' }).click();
    await expect(window.locator('.tree-special-file', { hasText: 'Global CLAUDE' })).toBeVisible();
    await shoot(window, 'global-claude');

    // Refresh re-reads the active tree without blowing up the pane.
    await window.locator('.skills-refresh').click();
    await expect(window.locator('.tree-special-file', { hasText: 'Global CLAUDE' })).toBeVisible();
  } finally {
    await cleanup();
    await rm(globalDir, { recursive: true, force: true });
  }
});
