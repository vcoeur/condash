import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end smoke for the Resources and Skills working surfaces.
 *
 * Each test boots a fresh fixture conception with a `resources/` tree and a
 * `.claude/skills/` tree, toggles into the matching pane, and checks that
 * the pane renders + a primary action wires up. We deliberately keep the
 * matrix small — Vitest already covers the tree-reader and search-walk
 * logic; these specs only verify the renderer ↔ IPC ↔ FS round-trip.
 */
test('Resources pane: handle, render, copy path, view markdown', async () => {
  const booted = await bootApp();
  const { window, conceptionDir, cleanup } = booted;
  try {
    await mkdir(join(conceptionDir, 'resources'), { recursive: true });
    await writeFile(
      join(conceptionDir, 'resources', 'README.md'),
      '# Resources home\n\nA short summary paragraph.\n',
      'utf8',
    );
    await writeFile(
      join(conceptionDir, 'resources', 'spec.txt'),
      'plain text fixture body',
      'utf8',
    );

    // The resources tree is read on-demand when the pane mounts. The watcher
    // also fires `tree-events` for newly-written files; either way, clicking
    // the handle below pulls the freshly-walked tree.
    const resourcesHandle = window
      .locator('.edge-strip-right .edge-handle')
      .filter({ hasText: 'Resources' });
    await expect(resourcesHandle).toBeVisible();
    await resourcesHandle.click();

    await expect(window.locator('.resources-pane')).toBeVisible();
    await expect(
      window.locator('.resources-card-title', { hasText: 'Resources home' }),
    ).toBeVisible();
    await expect(window.locator('.resources-card-title', { hasText: 'spec.txt' })).toBeVisible();

    // Copy-path writes the absolute path into the system clipboard. The
    // Electron sandbox has clipboard access; we read it back through the
    // same surface the renderer uses.
    const copyButton = window
      .locator('.resources-card', { hasText: 'Resources home' })
      .locator('.resources-card-action', { hasText: 'copy' });
    await copyButton.click();
    const clipboard = await window.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('resources/README.md');

    // Clicking the card body of a markdown resource opens the note modal in
    // read-only mode — the read-only tag in the header confirms the prop is
    // threaded through.
    await window
      .locator('.resources-card', { hasText: 'Resources home' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.note-modal')).toBeVisible();
    await expect(window.locator('.modal-readonly-tag')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('Skills pane: SKILL.md badge + shipped chip + diverged warning', async () => {
  const skillBody = '# Projects skill\n\nLead paragraph.\n';
  // Compute the SHA without a renderer (matches Node's crypto). The fixture
  // is dropped onto disk before Electron launches, so we can't go via
  // `window.evaluate` for the hash — and we don't need to: SHA-256 is the
  // same algorithm everywhere.
  const skillSha = createHash('sha256').update(skillBody, 'utf8').digest('hex');

  const booted = await bootApp({
    // Skill files go in before launch so the initial `readSkillsTree` picks
    // them up. Relying on the chokidar watcher to fire `add` events for
    // files created inside a freshly-mkdir'd directory was flaky under
    // CI's xvfb — events for the inner SKILL.md were occasionally
    // dropped when the inotify hook hadn't attached to the new dir yet.
    prepare: async (conceptionDir) => {
      // Post-reframe the Skills pane reads `.agents/skills/` (the multi-harness
      // `.claude/skills` fan-out was dropped); the shipped manifest lives there.
      const skillsRoot = join(conceptionDir, '.agents', 'skills');
      await mkdir(join(skillsRoot, 'projects'), { recursive: true });
      // Manifest first, then the `.md` files. The watcher classifies only
      // `.md` paths (and unlinks) under the skills root as `skills` events,
      // so the manifest write itself never triggers a refetch. Post-reframe
      // the manifest lives at `.agents/.condash-skills.json` (one level above
      // the skills dir) and keys files under `source`, not `files`.
      await writeFile(
        join(conceptionDir, '.agents', '.condash-skills.json'),
        JSON.stringify({
          version: 1,
          skills: {
            projects: {
              source: {
                'SKILL.md': { sha256: skillSha, shippedVersion: '2.10.15' },
                'create.md': { sha256: 'deadbeef', shippedVersion: '2.10.15' },
              },
            },
          },
        }),
        'utf8',
      );
      await writeFile(join(skillsRoot, 'projects', 'SKILL.md'), skillBody, 'utf8');
      await writeFile(
        join(skillsRoot, 'projects', 'create.md'),
        '# Create\n\nCreate body.\n',
        'utf8',
      );
    },
  });
  const { window, cleanup } = booted;
  try {
    const skillsHandle = window
      .locator('.edge-strip-right .edge-handle')
      .filter({ hasText: 'Skills' });
    await skillsHandle.click();

    await expect(window.locator('.skills-pane')).toBeVisible();
    // Expand the `projects/` sub-directory so its SKILL.md surfaces. The
    // skills-pane uppercases directory names for display (`PROJECTS`), so
    // the locator is case-insensitive. Directories start collapsed when
    // there is no persisted expansion state — a fresh per-test conception
    // never has one.
    const projectsHeader = window
      .locator('.tree-dir-header')
      .filter({ has: window.locator('.tree-dir-name', { hasText: /^projects$/i }) });
    await expect(projectsHeader).toBeVisible();
    if ((await projectsHeader.getAttribute('data-open')) !== 'true') {
      await projectsHeader.click();
    }
    // SKILL.md surfaces as a tree-special-file button (the [SKILL] badge
    // sits inside it). When the SHA matches the manifest, the button
    // carries a `shipped` class but not `diverged`.
    const skillBadge = window.locator('.skill-special-file').first();
    await expect(skillBadge).toBeVisible();
    await expect(skillBadge).toHaveClass(/\bshipped\b/);
    await expect(skillBadge).not.toHaveClass(/diverged/);
    // The body file's SHA mismatches → diverged chip on its card.
    const createCard = window.locator('.skills-card', { hasText: 'Create' });
    await expect(createCard).toBeVisible();
    await expect(createCard.locator('.skills-card-shipped[data-state="diverged"]')).toBeVisible();

    // Opening the diverged card surfaces the divergence banner above the body.
    await createCard.click();
    await expect(window.locator('.note-modal .modal-banner--warn')).toBeVisible();
  } finally {
    await cleanup();
  }
});
