import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Suggested links, end to end through the real pty.
 *
 * The unit suite pins the scorer with fixtures; what only an app-level spec can
 * prove is the chain between them — a real shell writes a project slug into a
 * real pty, main's rolling buffer captures it, the scan riding the 2.5 s memory
 * tick scores it, the verdict travels on the `termSessions` broadcast, the
 * controller reconciles it onto the Tab, the focus mirror publishes it, and the
 * card's Link button reads it. Every one of those hops is a place the field can
 * be silently dropped (the controller's own `SessionSnapshot` comment records
 * exactly that happening to the death verdict).
 *
 * The tab is spawned with a command that prints the slug itself rather than
 * typed into after the fact: typing into a freshly spawned tab has its own
 * settle problem, tracked separately, and it is not what this spec is about.
 *
 * `2026-04-26-sample` is the fixture project `bootApp` always ships, in `now`.
 */

const sampleCard = (window: Page) => window.locator('article.row', { hasText: 'Sample project' });
const linkButton = (window: Page) => sampleCard(window).locator('button.link-button');

/** Spawn a `my`-side tab running `command` and wait for its row to mount. */
async function spawnTab(window: Page, command: string): Promise<string> {
  const session = await window.evaluate(
    (cmd) => window.condash.termSpawn({ side: 'my', command: cmd }),
    command,
  );
  await window.waitForSelector(`[data-sid="${session.id}"]`, {
    state: 'attached',
    timeout: 10_000,
  });
  return session.id;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a tab that names a project turns that card’s Link button into a suggestion', async () => {
  const booted = await bootApp();
  try {
    const { window } = booted;
    // Print the dated slug, then idle so the tab stays live and the window keeps
    // holding the text. The scan needs one tick to build its needle set and one
    // to score, so the assertion polls rather than waiting a fixed span.
    await spawnTab(
      window,
      'echo working on 2026-04-26-sample; echo 2026-04-26-sample README; sleep 300',
    );

    await expect(linkButton(window)).toHaveText('Link (suggested)', { timeout: 30_000 });
    await expect(linkButton(window)).toHaveClass(/suggested/);
    // The visibility fix is part of the change: the suggested state is the
    // filled-accent recipe (opaque accent fill, semibold), not the washed
    // outline it replaced. Pin the computed recipe so a regression back to a
    // transparent fill cannot pass a text/class assertion.
    const style = await linkButton(window).evaluate((el) => {
      const computed = getComputedStyle(el);
      return { background: computed.backgroundColor, weight: computed.fontWeight };
    });
    expect(style.weight).toBe('600');
    // Fully opaque — parse the components so no transparent or translucent
    // value (the old state's wash) can pass. `rgb(...)` has three components
    // and is opaque by definition; `rgba(..., a)` has four, the last the alpha.
    // Chromium's computed backgroundColor is the comma-separated legacy form.
    const parts = (style.background.match(/rgba?\(([^)]+)\)/)?.[1] ?? '')
      .split(/[, ]+/)
      .filter(Boolean);
    const alpha = parts.length === 4 ? Number(parts[3]) : 1;
    expect(alpha).toBe(1);
  } finally {
    await booted.cleanup();
  }
});

test('a tab that names no project leaves the Link button plain', async () => {
  const booted = await bootApp();
  try {
    const { window } = booted;
    await spawnTab(window, 'echo running the test suite; echo 140 passed; sleep 300');

    // Enabled (a tab is focused) but never suggested. Held across several scan
    // ticks so a suggestion arriving late still fails this.
    await expect(linkButton(window)).toBeEnabled({ timeout: 15_000 });
    await expect(linkButton(window)).not.toHaveClass(/suggested/, { timeout: 8_000 });
    await expect(linkButton(window)).toHaveText('Link');
  } finally {
    await booted.cleanup();
  }
});

test('accepting a suggestion writes an ordinary manual link', async () => {
  const booted = await bootApp();
  try {
    const { window } = booted;
    const sid = await spawnTab(window, 'echo 2026-04-26-sample; echo 2026-04-26-sample; sleep 300');
    await expect(linkButton(window)).toHaveText('Link (suggested)', { timeout: 30_000 });

    await linkButton(window).click();

    // The relation is indistinguishable from one made by the plain button: same
    // store, same shape. That is the point of suggesting rather than writing —
    // nothing downstream has to know a suggestion was involved.
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            const raw = localStorage.getItem('condash:term:links:v1');
            return raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {};
          }),
        { timeout: 10_000 },
      )
      .toHaveProperty(['2026-04-26-sample', sid]);

    // Once linked, the card is decorated for the focused tab, and the Link
    // button is hidden outright — a second link of the same pair is a no-op
    // the button has nothing to say about. Unlinking lives on the fold.
    await expect(linkButton(window)).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('a project created after the tab printed its slug still becomes a suggestion', async () => {
  const booted = await bootApp();
  try {
    const { window, conceptionDir } = booted;
    const betaSlug = '2026-09-01-beta';
    // The tab names a project that does not exist yet — the exact shape of a
    // `condash projects create` run: the slug is printed, then the tab (or the
    // command) goes quiet. The scan ticks over this output while the needle
    // set does not know the slug, and the growth gate would never re-open the
    // tab once the needles caught up.
    await spawnTab(window, `echo planning ${betaSlug}; sleep 300`);

    // Let several scan ticks pass with the slug unrecognised. The plain-text
    // assertion alone would settle instantly — the button is plain by default —
    // so hold past TWO full 2.5 s sampler intervals afterwards: whatever phase
    // the timer was in when the output landed, at least one tick must have
    // scored the slug while it was still unrecognised, or the test could pass
    // vacuously on the old growth-gated code (a project created before the
    // first post-output tick would be recognised at that first tick). The scan
    // exposes no completion signal, so the ordering guarantee is a duration —
    // the length is two intervals, not one, precisely because the tick phase
    // relative to the output is unobservable here.
    await expect(linkButton(window)).toHaveText('Link', { timeout: 8_000 });
    await wait(5_500);

    // Now the project comes into existence on disk. The watcher invalidates
    // the needle set, the rebuild bumps the needle version, and that version
    // change — not new output — must re-open the scan for the silent tab.
    const dir = join(conceptionDir, 'projects', '2026-09', betaSlug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'README.md'),
      `---\ndate: 2026-09-01\nkind: project\nstatus: now\n---\n\n# Beta project\n`,
      'utf8',
    );

    const betaCard = window.locator('article.row', { hasText: 'Beta project' });
    await expect(betaCard).toBeVisible({ timeout: 15_000 });
    await expect(betaCard.locator('.link-button')).toHaveText('Link (suggested)', {
      timeout: 30_000,
    });
  } finally {
    await booted.cleanup();
  }
});
