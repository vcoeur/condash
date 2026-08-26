import { test, expect, type Page } from '@playwright/test';
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

    // Once linked, the card is decorated for the focused tab, so the button
    // stops advertising a suggestion for a relation that now exists.
    await expect(linkButton(window)).toHaveText('Link');
  } finally {
    await booted.cleanup();
  }
});
