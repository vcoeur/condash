import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Resources → "→ term" on a terminal pane that has no tab yet.
 *
 * The bridge has to spawn a shell and paste into it, and those are two
 * different addresses: the spawn resolves as soon as main has the pty, while
 * the tab reaches the renderer a reconcile pass later — after a dynamic xterm
 * import. Pasting on the line after the spawn therefore dropped the path
 * outright, with a real tab open and no error to show for it (measured 4 drops
 * in 4 runs of the real app before the fix).
 *
 * Only this surface gets an app-level spec. The sibling defect on the status
 * bar's Install button went through a 350 ms settle that a warm machine's
 * reconcile beats, so an E2E there passes with or without the fix — a vacuous
 * assertion. Its guarantee is pinned in `terminal-bridge.test.ts`, where the
 * roster insert and the activation are separate steps the double can hold
 * apart.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('pasting a resource path into an empty terminal pane reaches the spawned tab', async () => {
  const booted = await bootApp({
    globalConfig: {
      // Pane open, nothing in it — the state the defect needs.
      layout: { projects: true, leftView: 'projects', working: 'code', terminal: true },
    },
    prepare: async (conceptionDir) => {
      await mkdir(join(conceptionDir, 'resources'), { recursive: true });
      await writeFile(join(conceptionDir, 'resources', 'spec.txt'), 'fixture body', 'utf8');
    },
  });
  const { window, cleanup } = booted;
  try {
    // Armed before any tab exists: xterm-mount only registers buffers for
    // inspection when this attribute is already on the body.
    await window.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
    await expect(window.locator('.terminal-pane')).toBeVisible();
    expect(await window.locator('.terminal-tab[data-sid]').count()).toBe(0);

    await window.locator('.rail-item[title*="Resources"]').click();
    await expect(window.locator('.resources-pane')).toBeVisible();
    await window
      .locator('.resources-card', { hasText: 'spec.txt' })
      .locator('.resources-card-action', { hasText: 'term' })
      .click();

    // A tab must open, and the path must end up in that tab's buffer. Polled
    // rather than slept: the fix waits on the roster, not on a clock, and the
    // pre-fix failure is a buffer that stays empty however long you wait — so
    // this cannot pass by arriving early.
    await expect
      .poll(() => window.locator('.terminal-tab[data-sid]').count(), { timeout: 15_000 })
      .toBe(1);
    const sid = await window.locator('.terminal-tab[data-sid]').getAttribute('data-sid');
    expect(sid).toBeTruthy();
    await expect
      .poll(
        () =>
          window.evaluate((id) => {
            const term = window.__condashXterms?.get(id as string);
            if (!term) return '';
            const buf = term.buffer.active;
            const lines: string[] = [];
            for (let i = 0; i < buf.length; i++) {
              lines.push(buf.getLine(i)?.translateToString(true) ?? '');
            }
            return lines.join('\n');
          }, sid),
        { timeout: 15_000 },
      )
      .toContain('spec.txt');

    // Nothing was pasted anywhere else, and the user was not told a lie.
    await wait(500);
    expect(await window.locator('.toast').count()).toBe(0);
  } finally {
    await cleanup();
  }
});
