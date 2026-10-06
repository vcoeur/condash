import { test, expect } from '@playwright/test';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';
import { holdFirstCalls, type IpcGate } from './fixtures/ipc-hold';

/**
 * Visible-work gating of the PR badge index, replayed against the built app.
 * The renderer must initiate `listOpenPullRequests` batches only while the
 * Projects pane is actually rendered (conception open, pane toggled on,
 * welcome not replacing the band) — the accessor restored in main.tsx. The
 * acceptance currency is the invocation count on a gate installed through the
 * `beforeFirstWindow` boot seam; every PR payload is test-supplied through the
 * hold gate, so a badge assertion never touches the network (`fixture-app`
 * resolves to no configured repo, and the main-side handler returns `[]`
 * without spawning `gh` for it anyway).
 *
 * Assert outcomes (counts, painted badges), not hydration internals: the
 * zero-hidden-boot outcome flows through the async boot sequence — the
 * conception path is null at mount, and any transiently armed timer is dropped
 * when the persisted layout flips, far under the 1 s fire.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Trailing-debounce window (PR_INDEX_DEBOUNCE_MS) + margin: long enough that
 *  any batch a wrongly-open gate would have fired has landed. */
const SETTLE_MS = 2_500;

/** Eventually-true poll for a main-process gate count. */
async function waitForCount(count: () => Promise<number>, expected: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await count()) >= expected) return;
    await sleep(100);
  }
  throw new Error(`gate never reached ${expected} calls`);
}

const prPayload = (number: number, headRefName: string) => ({
  number,
  url: `https://example.invalid/pull/${number}`,
  title: `Probe PR ${number}`,
  isDraft: false,
  headRefName,
});

async function writeProbeProject(
  dir: string,
  slug: string,
  title: string,
  branch: string,
  app = 'fixture-app',
): Promise<void> {
  const projectDir = join(dir, 'projects', '2026-04', slug);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'README.md'),
    `# ${title}\n\n**Status**: now\n**Kind**: project\n**Apps**: \`${app}\`\n**Branch**: \`${branch}\`\n\n## Summary\n\nProbe project.\n\n## Steps\n\n- [ ] one\n`,
    'utf8',
  );
}

interface HiddenBoot {
  booted: Awaited<ReturnType<typeof bootApp>>;
  gate: IpcGate;
}

/** Boot with the Projects pane persisted off and one branch-bearing,
 *  app-tokened project, counting every `listOpenPullRequests` from process
 *  start. `hold` parks the first `hold` invocations for `releaseWithValue`. */
async function bootHidden(hold = 0): Promise<HiddenBoot> {
  let gate: IpcGate | undefined;
  const booted = await bootApp({
    globalConfig: { layout: { projects: false } },
    prepare: async (dir) => {
      await writeProbeProject(dir, '2026-04-26-pr-probe', 'Fixture PR probe', 'feature-probe');
    },
    beforeFirstWindow: async (app) => {
      gate = await holdFirstCalls(app, 'listOpenPullRequests', hold);
    },
  });
  return { booted, gate: gate! };
}

const railProjects = (booted: HiddenBoot) =>
  booted.booted.window.locator('.rail').getByRole('button', { name: 'Projects', exact: true });

const badge = (booted: HiddenBoot, number: number) =>
  booted.booted.window.locator('.pane-projects .pr-badge').filter({ hasText: `#${number}` });

test('a hidden Projects pane issues zero PR lookups on boot', async () => {
  const ctx = await bootHidden();
  const { booted, gate } = ctx;
  try {
    // The fixture project is in the (hidden) list — the zero below is a gated
    // non-empty batch, not an empty list doing nothing.
    await expect(booted.window.getByText('Fixture PR probe')).toHaveCount(1);
    await expect(booted.window.locator('.pane-projects')).toBeHidden();
    await sleep(SETTLE_MS);
    expect(await gate.count()).toBe(0);
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('showing the pane fires exactly one batch carrying the latest list', async () => {
  const ctx = await bootHidden();
  const { booted, gate } = ctx;
  try {
    await sleep(SETTLE_MS);
    expect(await gate.count()).toBe(0);

    await railProjects(ctx).click();
    await expect(booted.window.locator('.pane-projects')).toBeVisible();
    await expect(booted.window.getByText('Fixture PR probe')).toBeVisible();

    // One token in the list ⇒ one call, after the 1 s trailing debounce.
    await waitForCount(() => gate.count(), 1);
    await sleep(SETTLE_MS);
    expect(await gate.count()).toBe(1);
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('list churn while hidden queues nothing; re-show fires one further batch', async () => {
  const ctx = await bootHidden();
  const { booted, gate } = ctx;
  try {
    await railProjects(ctx).click();
    await waitForCount(() => gate.count(), 1);
    await railProjects(ctx).click();
    await expect(booted.window.locator('.pane-projects')).toBeHidden();

    // Real watcher churn: a second branch-bearing project lands while hidden.
    await writeProbeProject(
      booted.conceptionDir,
      '2026-04-26-pr-probe-2',
      'Second probe project',
      'second-probe',
    );
    // The churn reached the store even though the pane is display:none.
    await expect(booted.window.getByText('Second probe project')).toHaveCount(1);
    await sleep(SETTLE_MS);
    expect(await gate.count()).toBe(1);

    // Re-show: one further batch, not one per churn event.
    await railProjects(ctx).click();
    await expect(booted.window.getByText('Second probe project')).toBeVisible();
    await waitForCount(() => gate.count(), 2);
    await sleep(SETTLE_MS);
    expect(await gate.count()).toBe(2);
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('a reply released mid-hide never outlives the re-show batch it lost to', async () => {
  const ctx = await bootHidden(2);
  const { booted, gate } = ctx;
  try {
    await sleep(SETTLE_MS);
    expect(await gate.count()).toBe(0);

    // Show: the first batch parks on the gate.
    await railProjects(ctx).click();
    await waitForCount(() => gate.count(), 1);

    // Hide, then land the held reply into the retained index (invisibly).
    await railProjects(ctx).click();
    await expect(booted.window.locator('.pane-projects')).toBeHidden();
    await gate.releaseWithValue(0, [prPayload(2, 'feature-probe')]);

    // Re-show: the retained index paints #2 instantly while the fresh batch
    // (second held call) is still parked.
    await railProjects(ctx).click();
    await expect(booted.window.locator('.pane-projects')).toBeVisible();
    await waitForCount(() => gate.count(), 2);
    await expect(badge(ctx, 2)).toBeVisible();

    // The fresh batch's own outcome governs the end state: its exact swap
    // replaces the token's entries, so the held-over #2 cannot survive.
    // (Releasing splices the held queue, so the still-parked call is at 0.)
    await gate.releaseWithValue(0, [prPayload(999, 'feature-probe')]);
    await expect(badge(ctx, 999)).toBeVisible();
    await expect(badge(ctx, 2)).toHaveCount(0);
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('a visible boot paints card badges from the released batch payload', async () => {
  let gate: IpcGate | undefined;
  const booted = await bootApp({
    prepare: async (dir) => {
      await writeProbeProject(dir, '2026-04-26-pr-probe', 'Fixture PR probe', 'feature-probe');
    },
    beforeFirstWindow: async (app) => {
      gate = await holdFirstCalls(app, 'listOpenPullRequests', 1);
    },
  });
  try {
    const ctx = { booted, gate: gate! };
    // Default layout has the Projects pane open: the boot batch is the held
    // call — exactly one (the tree watcher adds no boot-time churn).
    await expect(booted.window.getByText('Fixture PR probe')).toBeVisible();
    await waitForCount(() => gate!.count(), 1);
    await expect(booted.window.locator('.pane-projects .pr-badge')).toHaveCount(0);

    // The batch's payload arrives from the test — no network, no `gh`.
    await gate!.releaseWithValue(0, [prPayload(7, 'feature-probe')]);
    await expect(badge(ctx, 7)).toBeVisible();
    await sleep(SETTLE_MS);
    expect(await gate!.count()).toBe(1);
    await gate!.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('the welcome screen replacing the band initiates no lookup', async () => {
  let gate: IpcGate | undefined;
  const booted = await bootApp({
    beforeFirstWindow: async (app) => {
      gate = await holdFirstCalls(app, 'listOpenPullRequests', 0);
    },
  });
  try {
    // Empty the tree for real: no projects, no knowledge — the welcome
    // replaces the whole top band. Knowledge goes first and settles: the
    // welcome's knowledge probe reads the tree once, when the project list
    // empties, so it must already see an empty knowledge/ at that moment.
    await unlink(join(booted.conceptionDir, 'knowledge', 'index.md'));
    await sleep(1_500);
    await unlink(
      join(booted.conceptionDir, 'projects', '2026-04', '2026-04-26-sample', 'README.md'),
    );
    await expect(booted.window.locator('.welcome-screen')).toBeVisible({ timeout: 15_000 });
    await expect(booted.window.locator('.pane-projects')).toHaveCount(0);
    await sleep(SETTLE_MS);
    expect(await gate!.count()).toBe(0);
    await gate!.uninstall();
  } finally {
    await booted.cleanup();
  }
});
