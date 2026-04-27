import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('Run on a configured repo spawns the run: command and emits its output', async () => {
  const booted = await bootApp({
    extraConfig: {
      workspace_path: '/tmp',
      repositories: {
        primary: [{ name: '.', run: 'echo hi-from-runner' }],
      },
    },
  });
  try {
    const session = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'code', repo: '.' }),
    );
    expect(typeof session.id).toBe('string');

    // `echo` finishes fast and the pty may exit before a renderer-side
    // term.data listener can attach. Poll term.attach (which serves the
    // buffered tail kept in main) until the runner output shows up.
    let output = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const attached = await booted.window.evaluate(
        (id) => window.condash.termAttach(id),
        session.id,
      );
      output = attached?.output ?? '';
      if (output.includes('hi-from-runner')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain('hi-from-runner');

    await booted.window.evaluate((id) => window.condash.termClose(id), session.id);
  } finally {
    await booted.cleanup();
  }
});

/**
 * Read the PID printed by the fixture command from the buffered tail of a
 * session. The fixture prints `PID:<pid>\n` first, then `exec sleep 30`s
 * itself — so the pid is the leader of the process group that Stop must
 * tear down.
 */
async function readPid(window: import('@playwright/test').Page, id: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const attached = await window.evaluate((sid) => window.condash.termAttach(sid), id);
    const match = (attached?.output ?? '').match(/PID:(\d+)/);
    if (match) return Number(match[1]);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('did not see PID line in run output');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('termClose tears down the process tree (parity-batch-7 Stop pipeline)', async () => {
  const booted = await bootApp({
    extraConfig: {
      workspace_path: '/tmp',
      repositories: {
        // `exec sleep 30` makes the pid we print *become* the sleep process —
        // so if the kill only reaches the wrapping bash and not its child,
        // the test harness will still see this pid alive after termClose.
        primary: [{ name: '.', run: 'echo PID:$$; exec sleep 30' }],
      },
    },
  });
  try {
    const session = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'code', repo: '.' }),
    );
    const pid = await readPid(booted.window, session.id);
    expect(isProcessAlive(pid)).toBe(true);

    await booted.window.evaluate((id) => window.condash.termClose(id), session.id);

    // Stop pipeline: SIGTERM → (no force_stop) → SIGKILL fallback after 500ms.
    // Allow up to 1.5 s for the kernel to reap.
    let alive = true;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!isProcessAlive(pid)) {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive).toBe(false);
  } finally {
    await booted.cleanup();
  }
});

test('spawning a second run for the same repo replaces the first', async () => {
  const booted = await bootApp({
    extraConfig: {
      workspace_path: '/tmp',
      repositories: {
        primary: [{ name: '.', run: 'echo PID:$$; exec sleep 30' }],
      },
    },
  });
  try {
    const first = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'code', repo: '.' }),
    );
    const firstPid = await readPid(booted.window, first.id);
    expect(isProcessAlive(firstPid)).toBe(true);

    const second = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'code', repo: '.' }),
    );
    expect(second.id).not.toBe(first.id);

    // After spawnTerminal awaits the prior Stop, only the new session remains.
    const list = await booted.window.evaluate(() => window.condash.termList());
    const codeRunsForRepo = list.filter(
      (s: { side: string; repo?: string; exited?: number }) =>
        s.side === 'code' && s.repo === '.',
    );
    expect(codeRunsForRepo.map((s) => s.id)).toEqual([second.id]);

    // And the first run's process is gone.
    let alive = true;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!isProcessAlive(firstPid)) {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive).toBe(false);

    await booted.window.evaluate((id) => window.condash.termClose(id), second.id);
  } finally {
    await booted.cleanup();
  }
});
