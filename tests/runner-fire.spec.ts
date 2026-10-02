import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

test('Run on a configured repo spawns the run: command and emits its output', async () => {
  const booted = await bootApp({
    extraConfig: {
      workspace_path: '/tmp',
      // `echo` exits immediately; once the renderer's TerminalPane sees
      // termExit it auto-closes the tab via termClose, and termAttach
      // then returns null because the session is gone. Trail with
      // `sleep 5` so the pty is alive while the test polls for output.
      repositories: [{ name: '.', run: 'echo hi-from-runner; sleep 5' }],
    },
  });
  try {
    const session = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'code', repo: '.' }),
    );
    expect(typeof session.id).toBe('string');

    // The CDP roundtrip can still beat the pty's first write, so we poll.
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
  let lastOutput = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    const attached = await window.evaluate((sid) => window.condash.termAttach(sid), id);
    lastOutput = attached?.output ?? '(session missing)';
    const match = lastOutput.match(/PID:(\d+)/);
    if (match) return Number(match[1]);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`did not see PID line in run output: ${JSON.stringify(lastOutput.slice(-1000))}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Keep PID expansion in a script, beyond the scope launcher's argv expansion. */
async function bootPidRun() {
  return bootApp({
    prepare: async (root) => {
      await writeFile(join(root, 'pid-fixture.sh'), 'echo PID:$$\nexec sleep 30\n');
      await writeFile(
        join(root, '.condash', 'settings.json'),
        JSON.stringify({
          workspace_path: root,
          repositories: [{ name: '.', run: '/bin/sh ./pid-fixture.sh' }],
        }),
      );
    },
  });
}

test('termClose tears down the process tree (parity-batch-7 Stop pipeline)', async () => {
  const booted = await bootPidRun();
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
  const booted = await bootPidRun();
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
      (s: { side: string; repo?: string; exited?: number }) => s.side === 'code' && s.repo === '.',
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
