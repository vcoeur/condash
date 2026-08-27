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
  // Electron boot plus two 15 s polls overruns the 30 s default, so the red
  // case would die as a generic timeout instead of the buffer assertion. Repo
  // convention for boot-heavy specs.
  test.setTimeout(90_000);
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

    // Toasts self-dismiss after 4 s while the polls below are allowed 15 s, so
    // counting them at the end can miss one entirely. Record every toast that
    // ever appears instead, from before the click.
    await window.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __toastLog: string[] }).__toastLog = seen;
      // Record whatever the toast slot currently says, on any mutation. Watching
      // only for *added* nodes misses the case this observer exists for: the
      // toast is an unkeyed `<Show>`, and Solid memoises that condition on
      // truthiness, so a second toast arriving while the first is still up
      // rewrites the existing node's text and inserts nothing. On a slow boot
      // that is exactly how an unrelated toast would mask the failure toast.
      const record = (): void => {
        const text = document.querySelector('.toast')?.textContent ?? '';
        if (text && seen[seen.length - 1] !== text) seen.push(text);
      };
      new MutationObserver(record).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });

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
              const line = buf.getLine(i);
              if (!line) continue;
              // The pty runs the developer's own shell, so the prompt width is
              // whatever their PS1 is — a path near the wrap column would split
              // the token across two rows and fail the match for a reason that
              // has nothing to do with this fix. Rejoin continuation rows.
              const text = line.translateToString(true);
              if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
              else lines.push(text);
            }
            return lines.join('\n');
          }, sid),
        { timeout: 15_000 },
      )
      .toContain('spec.txt');

    // The user was not told a lie on the way there. Asserted against the
    // bridge's own error copy rather than "no toast at all": an unrelated
    // watcher or sync toast on a slow boot would otherwise fail this spec with
    // a message reading as "the paste lied to the user".
    await wait(500);
    const toasts = await window.evaluate(
      () => (window as unknown as { __toastLog: string[] }).__toastLog,
    );
    expect(
      toasts.filter((t) => /nothing was sent|no longer live|did not open in time/.test(t)),
    ).toEqual([]);
  } finally {
    await cleanup();
  }
});
