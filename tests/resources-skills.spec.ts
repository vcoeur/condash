import { test, expect } from '@playwright/test';
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
  const booted = await bootApp();
  const { window, conceptionDir, cleanup } = booted;
  try {
    const skillsRoot = join(conceptionDir, '.claude', 'skills');
    await mkdir(join(skillsRoot, 'projects'), { recursive: true });
    const skillBody = '# Projects skill\n\nLead paragraph.\n';
    await writeFile(join(skillsRoot, 'projects', 'SKILL.md'), skillBody, 'utf8');
    await writeFile(
      join(skillsRoot, 'projects', 'create.md'),
      '# Create\n\nCreate body.\n',
      'utf8',
    );

    // Pre-compute the SHA so SKILL.md is "clean shipped" and create.md is
    // "diverged shipped" — then we can assert both badge variants in one go.
    const skillSha = await window.evaluate(async (text: string) => {
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }, skillBody);

    await writeFile(
      join(skillsRoot, '.condash-skills.json'),
      JSON.stringify({
        version: 1,
        skills: {
          projects: {
            files: {
              'SKILL.md': { sha256: skillSha, shippedVersion: '2.10.15' },
              'create.md': { sha256: 'deadbeef', shippedVersion: '2.10.15' },
            },
          },
        },
      }),
      'utf8',
    );

    const skillsHandle = window
      .locator('.edge-strip-right .edge-handle')
      .filter({ hasText: 'Skills' });
    await skillsHandle.click();

    await expect(window.locator('.skills-pane')).toBeVisible();
    // SKILL.md surfaces as the [SKILL] section badge with the "shipped" tag.
    const skillBadge = window.locator('.skills-section-index').first();
    await expect(skillBadge).toBeVisible();
    await expect(skillBadge).toHaveClass(/shipped/);
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
