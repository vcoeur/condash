import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end for the Skills pane's conception/user scope toggle (+ refresh).
 * Boots a fixture conception with a `.agents/skills/` skill for the conception
 * scope and a separate temp tree wired in via the `CONDASH_USER_*` overrides
 * for the user scope, then verifies flipping the scope swaps the tree.
 *
 * Vitest (`src/main/skills.test.ts`) already covers the reader logic; this
 * spec verifies the renderer ↔ IPC ↔ FS round-trip. Screenshots land in
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

test('Skills pane: conception/user scope toggle + refresh', async () => {
  // User-scope fixture tree, pointed at by the CONDASH_USER_* overrides the
  // reframed pane reads (just the skills root + the AGENTS.md path now).
  const globalDir = await mkdtemp(join(tmpdir(), 'condash-user-skills-'));
  await mkdir(join(globalDir, 'g-skills', 'usertool'), { recursive: true });
  await writeFile(
    join(globalDir, 'g-skills', 'usertool', 'SKILL.md'),
    '# User tool\n\nUser-scope skill.\n',
    'utf8',
  );
  await writeFile(join(globalDir, 'AGENTS.md'), '# User AGENTS\n\nUser base.\n', 'utf8');

  const booted = await bootApp({
    env: {
      CONDASH_USER_SKILLS_ROOT: join(globalDir, 'g-skills'),
      CONDASH_USER_AGENTS_MD: join(globalDir, 'AGENTS.md'),
    },
    prepare: async (conceptionDir) => {
      // A conception-scope skill under `.agents/skills/` (the reframed source).
      await mkdir(join(conceptionDir, '.agents', 'skills', 'conctool'), { recursive: true });
      await writeFile(
        join(conceptionDir, '.agents', 'skills', 'conctool', 'SKILL.md'),
        '# Conception tool\n\nConception-scope skill.\n',
        'utf8',
      );
    },
  });
  const { window, cleanup } = booted;
  try {
    await window.locator('.edge-strip-right .edge-handle').filter({ hasText: 'Skills' }).click();
    await expect(window.locator('.skills-pane')).toBeVisible();

    // Both scope buttons render; Conception is the default + active.
    const conceptionBtn = window.locator('.skills-scope-btn', { hasText: 'Conception' });
    const userBtn = window.locator('.skills-scope-btn', { hasText: 'User' });
    await expect(conceptionBtn).toBeVisible();
    await expect(userBtn).toBeVisible();
    await expect(conceptionBtn).toHaveAttribute('aria-pressed', 'true');

    // Conception scope shows the conception skill, not the user one.
    const conctool = window.locator('.tree-dir-name', { hasText: /^conctool$/i });
    await expect(conctool).toBeVisible();
    await expect(window.locator('.tree-dir-name', { hasText: /^usertool$/i })).toHaveCount(0);
    await shoot(window, 'conception-scope');

    // Flip to User — the tree swaps to the user-scope skill.
    await userBtn.click();
    await expect(userBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('.tree-dir-name', { hasText: /^usertool$/i })).toBeVisible();
    await expect(window.locator('.tree-dir-name', { hasText: /^conctool$/i })).toHaveCount(0);
    await shoot(window, 'user-scope');

    // Refresh re-reads the active tree without blowing up the pane.
    await window.locator('.skills-refresh').click();
    await expect(window.locator('.tree-dir-name', { hasText: /^usertool$/i })).toBeVisible();
  } finally {
    await cleanup();
    await rm(globalDir, { recursive: true, force: true });
  }
});
