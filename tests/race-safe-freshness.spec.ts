import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';
import { holdFirstCalls } from './fixtures/ipc-hold';

/**
 * Race-safe freshness, replayed against the built app: each case holds an
 * IPC reply through the exact stale-reply sequence (watcher event during
 * the flight, context switch, competing read) and asserts the newest
 * content paints without a manual Refresh. The holds are test-harness
 * interception of existing handlers (tests/fixtures/ipc-hold.ts) — no
 * application IPC, no production instrumentation.
 */

/** Real-time wait for watcher debounce windows. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Eventually-true poll for main-process gate counts. */
async function waitForCount(count: () => Promise<number>, expected: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await count()) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gate never reached ${expected} calls`);
}

test('a knowledge change during a held tree read coalesces into a trailing read that paints the newest content', async ({}, testInfo) => {
  const booted = await bootApp();
  try {
    const gate = await holdFirstCalls(booted.app, 'readKnowledgeTree', 1);
    await sendMenu(booted.app, 'show-knowledge');
    // The pane's activation read is parked; the pane shows its empty state.
    await expect(booted.window.locator('.pane-working')).toBeVisible();

    // The file changes while the read is held — a real watcher event.
    await writeFile(
      join(booted.conceptionDir, 'knowledge', 'held-race-note.md'),
      '# Held race note\n\nWritten while the first read was still in flight.\n',
      'utf8',
    );
    await sleep(600);

    // The stale reply (pre-change content) is released: it applies as the
    // flight owner, then exactly one trailing read re-reads the world.
    const knowledgeDir = join(booted.conceptionDir, 'knowledge');
    await gate.releaseWithValue(0, {
      relPath: '',
      name: 'knowledge',
      title: 'knowledge',
      kind: 'directory',
      path: knowledgeDir,
      children: [
        {
          relPath: 'index.md',
          name: 'index.md',
          title: 'knowledge',
          kind: 'file',
          path: join(knowledgeDir, 'index.md'),
        },
      ],
    });

    // The trailing read paints the newest content — no manual refresh.
    await expect(booted.window.getByText('Held race note')).toBeVisible({ timeout: 10_000 });
    await booted.window
      .locator('.pane-working')
      .screenshot({ path: testInfo.outputPath('tree-trailing-read.png') });
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('a Skills scope switch never paints the prior scope\u2019s held reply', async ({}, testInfo) => {
  const userRoot = await mkdtemp(join(tmpdir(), 'condash-user-skills-'));
  try {
    await mkdir(join(userRoot, 'user-probe-skill'), { recursive: true });
    await writeFile(
      join(userRoot, 'user-probe-skill', 'SKILL.md'),
      '# User scope probe\n\nOnly in the user scope fixture.\n',
      'utf8',
    );
    await writeFile(join(userRoot, 'AGENTS.md'), '# User skills fixture\n', 'utf8');
    const booted = await bootApp({
      env: {
        CONDASH_USER_SKILLS_ROOT: userRoot,
        CONDASH_USER_AGENTS_MD: join(userRoot, 'AGENTS.md'),
      },
      prepare: async (dir) => {
        await mkdir(join(dir, '.agents', 'skills', 'conception-probe-skill'), {
          recursive: true,
        });
        await writeFile(
          join(dir, '.agents', 'skills', 'conception-probe-skill', 'SKILL.md'),
          '# Conception scope probe\n\nOnly in the conception scope fixture.\n',
          'utf8',
        );
      },
    });
    try {
      const gate = await holdFirstCalls(booted.app, 'readSkillsTree', 1);
      await sendMenu(booted.app, 'show-skills');
      // The conception-scope read is parked.
      await expect(booted.window.locator('.pane-working')).toBeVisible();

      // Flip to the user scope: a new flight for the new key starts and
      // passes through the gate (call 2) — the held conception reply is now
      // permanently ineligible.
      await booted.window.getByRole('button', { name: 'User', exact: true }).click();
      await expect(booted.window.getByText('user-probe-skill')).toBeVisible({ timeout: 10_000 });

      // The prior scope's reply resolves last — it must not paint under User.
      await gate.releaseWithValue(0, {
        relPath: '',
        name: 'skills',
        title: 'skills',
        kind: 'directory',
        path: join(booted.conceptionDir, '.agents', 'skills'),
        children: [
          {
            relPath: 'conception-probe-skill',
            name: 'conception-probe-skill',
            title: 'conception-probe-skill',
            kind: 'directory',
            path: join(booted.conceptionDir, '.agents', 'skills', 'conception-probe-skill'),
            children: [
              {
                relPath: 'conception-probe-skill/SKILL.md',
                name: 'SKILL.md',
                title: 'Conception scope probe',
                kind: 'file',
                path: join(
                  booted.conceptionDir,
                  '.agents',
                  'skills',
                  'conception-probe-skill',
                  'SKILL.md',
                ),
              },
            ],
          },
        ],
      });
      await expect(booted.window.getByText('user-probe-skill')).toBeVisible();
      await expect(booted.window.getByText('conception-probe-skill')).toHaveCount(0);
      await booted.window
        .locator('.pane-working')
        .screenshot({ path: testInfo.outputPath('skills-scope-switch.png') });
      await gate.uninstall();
    } finally {
      await booted.cleanup();
    }
  } finally {
    await rm(userRoot, { recursive: true, force: true });
  }
});

test('a held project reply cannot resurrect a path the same watcher stream deleted', async ({}, testInfo) => {
  const booted = await bootApp({
    prepare: async (dir) => {
      await mkdir(join(dir, 'projects', '2026-01', '2026-01-01-alpha-probe'), {
        recursive: true,
      });
      await writeFile(
        join(dir, 'projects', '2026-01', '2026-01-01-alpha-probe', 'README.md'),
        '# Alpha probe\n\n**Status**: now\n\n## Steps\n\n- [ ] one\n',
        'utf8',
      );
      await mkdir(join(dir, 'projects', '2026-01', '2026-01-01-beta-probe'), { recursive: true });
      await writeFile(
        join(dir, 'projects', '2026-01', '2026-01-01-beta-probe', 'README.md'),
        '# Beta probe\n\n**Status**: now\n\n## Steps\n\n- [ ] one\n',
        'utf8',
      );
    },
  });
  try {
    await expect(booted.window.getByText('Alpha probe')).toBeVisible({ timeout: 15_000 });
    await expect(booted.window.getByText('Beta probe')).toBeVisible();

    const gate = await holdFirstCalls(booted.app, 'getProject', 1);
    // Change alpha: the watcher patch lookup is issued — and parked here.
    await writeFile(
      join(booted.conceptionDir, 'projects', '2026-01', '2026-01-01-alpha-probe', 'README.md'),
      '# Alpha probe\n\n**Status**: review\n\n## Steps\n\n- [ ] one\n',
      'utf8',
    );
    await waitForCount(() => gate.count(), 1);

    // Now the same watcher stream deletes alpha and updates beta; both land
    // in one batch whose registration runs before any awaited lookup.
    await unlink(
      join(booted.conceptionDir, 'projects', '2026-01', '2026-01-01-alpha-probe', 'README.md'),
    );
    await writeFile(
      join(booted.conceptionDir, 'projects', '2026-01', '2026-01-01-beta-probe', 'README.md'),
      '# Beta updated\n\n**Status**: now\n\n## Steps\n\n- [ ] one\n',
      'utf8',
    );
    await expect(booted.window.getByText('Beta updated')).toBeVisible({ timeout: 15_000 });
    await expect(booted.window.getByText('Alpha probe')).toHaveCount(0);

    // The pre-deletion reply resolves last — it must not resurrect alpha.
    await gate.releaseWithValue(0, {
      slug: '2026-01-01-alpha-probe',
      path: join(booted.conceptionDir, 'projects', '2026-01', '2026-01-01-alpha-probe'),
      title: 'Alpha probe resurrected',
      kind: 'project',
      status: 'now',
      apps: [],
      branch: null,
      base: null,
      parent: null,
      timeline: [],
    });
    await expect(booted.window.getByText('Beta updated')).toBeVisible();
    await expect(booted.window.getByText('Alpha probe resurrected')).toHaveCount(0);
    await expect(booted.window.getByText('Alpha probe')).toHaveCount(0);
    await booted.window
      .locator('.pane-projects')
      .screenshot({ path: testInfo.outputPath('projects-no-resurrection.png') });
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});

test('a stale whole-list reply never reverts the newer per-primary state', async ({}, testInfo) => {
  const booted = await bootApp({
    prepare: async (dir) => {
      // Two real repos so the Code pane has cards and git can count dirt.
      for (const name of ['alpha-repo', 'beta-repo']) {
        const repo = join(dir, name);
        await mkdir(repo, { recursive: true });
        await writeFile(join(repo, 'README.md'), `# ${name}\n`, 'utf8');
      }
    },
  });
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const git = promisify(execFile);
    for (const name of ['alpha-repo', 'beta-repo']) {
      const repo = join(booted.conceptionDir, name);
      await git('git', ['init', '-b', 'main'], { cwd: repo });
      await git('git', ['config', 'user.email', 'probe@example.org'], { cwd: repo });
      await git('git', ['config', 'user.name', 'probe'], { cwd: repo });
      await git('git', ['add', '-A'], { cwd: repo });
      await git('git', ['commit', '-m', 'init'], { cwd: repo });
    }
    // Point the conception's repo list at the two workspaces (absolute paths).
    const settingsPath = join(booted.conceptionDir, '.condash', 'settings.json');
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          repositories: [
            { name: 'alpha-repo', path: join(booted.conceptionDir, 'alpha-repo') },
            { name: 'beta-repo', path: join(booted.conceptionDir, 'beta-repo') },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    // A config event re-roots the repo watchers and refetches the list.
    await expect(booted.window.getByText('2 repos', { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    const gate = await holdFirstCalls(booted.app, 'listRepos', 1);
    // View → Refresh issues a whole-list read; parked here (pre-dirt state).
    await sendMenu(booted.app, 'refresh');
    await waitForCount(() => gate.count(), 1);

    // The worktree becomes dirty; the repo watcher pushes a scalar event.
    await writeFile(join(booted.conceptionDir, 'alpha-repo', 'wip.txt'), 'dirty\n', 'utf8');
    await expect(booted.window.getByText('1 dirty')).toBeVisible({ timeout: 20_000 });

    // A structural push for alpha triggers the per-primary read — it runs
    // for real, commits, and is newer than the parked whole-list read.
    await booted.app.evaluate(
      ({ BrowserWindow }, repoPath) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('repo-events', [
          { kind: 'repo-worktrees-changed', repoPath },
        ]);
      },
      join(booted.conceptionDir, 'alpha-repo'),
    );
    await expect(booted.window.getByText('1 dirty')).toBeVisible({ timeout: 10_000 });

    // The stale whole-list reply (pre-dirt) resolves last: it must be
    // discarded — one recovery read re-reads the real (still dirty) world.
    await gate.releaseWithOriginal(0);
    await expect(booted.window.getByText('1 dirty')).toBeVisible({ timeout: 10_000 });
    // Give any wrong-path revert a moment to show itself.
    await sleep(1_000);
    await expect(booted.window.getByText('1 dirty')).toBeVisible();
    await booted.window
      .locator('.pane-working')
      .screenshot({ path: testInfo.outputPath('code-stale-full-discarded.png') });
    await gate.uninstall();
  } finally {
    await booted.cleanup();
  }
});
