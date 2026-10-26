import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootApp } from './fixtures/electron-app';
import { holdFirstCalls } from './fixtures/ipc-hold';

test('Copy link uses local conception branch, real clipboard, failure toast and hidden unsupported origins', async ({}, testInfo) => {
  const booted = await bootApp({
    prepare: async (root) => {
      execFileSync('git', ['-C', root, 'init', '-b', 'conception/topic']);
      execFileSync('git', [
        '-C',
        root,
        'remote',
        'add',
        'origin',
        'git@gitlab.com:group/nested/conception.git',
      ]);
    },
  });
  try {
    const page = booted.window;
    const gate = await holdFirstCalls(booted.app, 'getProjectForgeLink', 1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.row .title-text').first().click();
    const preview = page.locator('.modal.project-preview');
    const copy = preview.getByRole('button', { name: 'Copy link', exact: true });
    await expect(preview).toBeVisible();
    await expect.poll(() => gate.count()).toBe(1);
    await expect(copy).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('copy-link-before.png') });
    await gate.releaseWithOriginal(0);
    await expect(copy).toBeVisible();
    await expect(copy).toHaveAttribute('title', /404 until pushed/);
    await page.screenshot({ path: testInfo.outputPath('copy-link-after.png') });
    await copy.click();
    await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
    const clipboard = await booted.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clipboard).toMatch(
      /^https:\/\/gitlab.com\/group\/nested\/conception\/-\/tree\/conception%2Ftopic\/projects\//,
    );
    expect(clipboard).not.toContain('README.md');
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new Error('fixture denied')),
      });
    });
    await copy.click();
    await expect(page.getByText('Copy failed: fixture denied', { exact: true })).toBeVisible();
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    execFileSync('git', [
      '-C',
      booted.conceptionDir,
      'remote',
      'set-url',
      'origin',
      'https://unsupported.example/group/repo',
    ]);
    await page.locator('.row .title-text').first().click();
    await expect(preview).toBeVisible();
    // Wait for the real unsupported lookup, not merely the initial pending state.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const project = (await window.condash.listProjects())[0];
          return window.condash.getProjectForgeLink(project.path);
        }),
      )
      .toBeNull();
    await expect(copy).toHaveCount(0);
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('late link replies cannot reclaim a different preview or conception', async () => {
  const second = await mkdtemp(join(tmpdir(), 'condash-forge-second-'));
  const secondItem = join(second, 'projects', '2026-10', '2026-10-26-second');
  await mkdir(secondItem, { recursive: true });
  await mkdir(join(second, '.condash'));
  await writeFile(join(second, '.condash', 'settings.json'), '{}');
  await writeFile(
    join(secondItem, 'README.md'),
    '# Second conception item\n\n**Status**: now\n**Kind**: project\n',
  );
  const booted = await bootApp({
    prepare: async (root) => {
      execFileSync('git', ['-C', root, 'init', '-b', 'conception/topic']);
      execFileSync('git', [
        '-C',
        root,
        'remote',
        'add',
        'origin',
        'https://github.com/owner/conception.git',
      ]);
      const other = join(root, 'projects', '2026-10', '2026-10-26-other');
      await mkdir(other, { recursive: true });
      await writeFile(
        join(other, 'README.md'),
        '# Other item\n\n**Status**: now\n**Kind**: project\n',
      );
    },
  });
  try {
    const page = booted.window;
    const preview = page.locator('.modal.project-preview');
    const copy = preview.getByRole('button', { name: 'Copy link', exact: true });
    const gate = await holdFirstCalls(booted.app, 'getProjectForgeLink', 2);
    await page.locator('.row .title-text', { hasText: 'Sample project' }).click();
    await expect.poll(() => gate.count()).toBe(1);
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.row .title-text', { hasText: 'Other item' }).click();
    await expect.poll(() => gate.count()).toBe(2);
    await gate.releaseWithOriginal(0);
    await expect(copy).toHaveCount(0);
    await gate.releaseWithOriginal(0);
    await expect(copy).toBeVisible();
    await copy.click();
    expect(await booted.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'https://github.com/owner/conception/tree/conception%2Ftopic/projects/2026-10/2026-10-26-other',
    );
    await gate.uninstall();
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    const transitionGate = await holdFirstCalls(booted.app, 'getProjectForgeLink', 1);
    await page.locator('.row .title-text', { hasText: 'Sample project' }).click();
    await expect.poll(() => transitionGate.count()).toBe(1);
    await booted.app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path);
    }, second);
    await expect(
      page.locator('.row .title-text', { hasText: 'Second conception item' }),
    ).toBeVisible();
    await page.locator('.row .title-text', { hasText: 'Second conception item' }).click();
    await expect(preview).toBeVisible();
    await transitionGate.releaseWithOriginal(0);
    await expect(copy).toHaveCount(0);
    await transitionGate.uninstall();
  } finally {
    await booted.cleanup();
  }
});
