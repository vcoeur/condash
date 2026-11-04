import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';
import { holdFirstCalls } from './fixtures/ipc-hold';

type Booted = Awaited<ReturnType<typeof bootApp>>;

async function holdFailures(booted: Booted) {
  await booted.app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      }
    )._invokeHandlers;
    const state = globalThis as unknown as {
      failedToggles: { args: unknown[]; release: () => void }[];
    };
    state.failedToggles = [];
    handlers.set('toggleStep', async (...args) => {
      const index = state.failedToggles.length;
      await new Promise<void>((resolve) =>
        state.failedToggles.push({ args: args.slice(1), release: resolve }),
      );
      throw new Error(`Held write failure ${index}`);
    });
  });
}

async function releaseFailure(booted: Booted, index: number) {
  await booted.app.evaluate((_electron, index) => {
    (globalThis as unknown as { failedToggles: { release: () => void }[] }).failedToggles[
      index
    ].release();
  }, index);
}

async function expectFailure(booted: Booted, index: number) {
  await expect(booted.window.locator('.toast')).toContainText(`Held write failure ${index}`);
}

async function openPreview(booted: Booted) {
  await booted.window.locator('.row').filter({ hasText: 'Sample project' }).first().click();
  const step = booted.window.locator('.step').filter({ hasText: 'First step' });
  await expect(step).toBeVisible();
  // Complete the preview's lazy detail read before counting repair reads.
  await expect(booted.window.locator('.project-preview')).toBeVisible();
  return step;
}

async function holdToggle(booted: Awaited<ReturnType<typeof bootApp>>) {
  await booted.app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      }
    )._invokeHandlers;
    const original = handlers.get('toggleStep')!;
    const state = globalThis as unknown as {
      toggleCalls: unknown[][];
      releaseToggle: () => void;
    };
    state.toggleCalls = [];
    const gate = new Promise<void>((resolve) => {
      state.releaseToggle = resolve;
    });
    handlers.set('toggleStep', async (...args) => {
      state.toggleCalls.push(args.slice(1));
      await gate;
      return original(...args);
    });
  });
}

async function releaseToggle(booted: Awaited<ReturnType<typeof bootApp>>) {
  await booted.app.evaluate(() => {
    (globalThis as unknown as { releaseToggle: () => void }).releaseToggle();
  });
}

test('watcher-before-rejection preserves the authoritative marker and exact drift error', async () => {
  const booted = await bootApp();
  try {
    await booted.window.locator('.row').filter({ hasText: 'Sample project' }).first().click();
    await holdToggle(booted);
    const step = booted.window.locator('.step').filter({ hasText: 'First step' });
    const elapsed = await step.locator('.step-toggle').evaluate((button) => {
      const start = performance.now();
      (button as HTMLButtonElement).click();
      if (!button.closest('.step')!.classList.contains('step-marker-doing'))
        throw new Error('Not optimistic');
      return performance.now() - start;
    });
    expect(elapsed).toBeLessThanOrEqual(16);
    await expect
      .poll(
        async () =>
          (
            await booted.app.evaluate(
              () => (globalThis as unknown as { toggleCalls: unknown[][] }).toggleCalls,
            )
          ).length,
      )
      .toBe(1);
    const path = join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md');
    const raw = await readFile(path, 'utf8');
    const changed = raw.replace('- [ ] First step', '- [!] First step');
    await writeFile(path, changed);
    await expect(step).toHaveClass(/step-marker-blocked/);
    await releaseToggle(booted);
    await expect(step).toHaveClass(/step-marker-blocked/);
    await expect(booted.window.locator('.toast')).toHaveText(
      "Toggle failed: Error invoking remote method 'toggleStep': Error: Drift: expected marker ' ' at line 11 but found '!'",
    );
    expect(await readFile(path, 'utf8')).toBe(changed);
    await expect(step).toHaveClass(/step-marker-blocked/);
  } finally {
    await booted.cleanup();
  }
});

test('an ordinary rejected write re-reads disk and clears the optimistic marker', async () => {
  const booted = await bootApp();
  try {
    const step = await openPreview(booted);
    await holdFailures(booted);
    await step.locator('.step-toggle').click();
    await expect(step).toHaveClass(/step-marker-doing/);
    await expect
      .poll(() =>
        booted.app.evaluate(
          () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
        ),
      )
      .toBe(1);
    await releaseFailure(booted, 0);
    await expectFailure(booted, 0);
    await expect(step).toHaveClass(/step-marker-todo/);
    expect(
      await readFile(
        join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md'),
        'utf8',
      ),
    ).toContain('- [ ] First step');
  } finally {
    await booted.cleanup();
  }
});

test('same-marker authoritative watcher publication defeats a held stale repair', async () => {
  const booted = await bootApp();
  try {
    const step = await openPreview(booted);
    await holdFailures(booted);
    const reads = await holdFirstCalls(booted.app, 'getProject', 1);
    await step.locator('.step-toggle').click();
    await expect
      .poll(() =>
        booted.app.evaluate(
          () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
        ),
      )
      .toBe(1);
    await releaseFailure(booted, 0);
    await expect.poll(reads.count).toBe(1);
    const path = join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(
        '- [ ] First step',
        '- [~] First step authoritative snapshot',
      ),
    );
    await expect(
      booted.window.locator('.step').filter({ hasText: 'First step authoritative snapshot' }),
    ).toHaveClass(/step-marker-doing/);
    await expect.poll(reads.count).toBe(2);
    await reads.releaseWithOriginal(0);
    await expectFailure(booted, 0);
    await expect(
      booted.window.locator('.step').filter({ hasText: 'First step authoritative snapshot' }),
    ).toHaveClass(/step-marker-doing/);
  } finally {
    await booted.cleanup();
  }
});

test('an older failure cannot repair over a newer in-flight local toggle', async () => {
  const booted = await bootApp();
  try {
    const step = await openPreview(booted);
    await holdFailures(booted);
    const reads = await holdFirstCalls(booted.app, 'getProject', 0);
    await step.locator('.step-toggle').evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect
      .poll(() =>
        booted.app.evaluate(
          () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
        ),
      )
      .toBe(2);
    await releaseFailure(booted, 0);
    await expectFailure(booted, 0);
    expect(await reads.count()).toBe(0);
    await expect(step).toHaveClass(/step-marker-done/);
    await releaseFailure(booted, 1);
    await expectFailure(booted, 1);
    await expect(step).toHaveClass(/step-marker-todo/);
    expect(await reads.count()).toBe(1);
  } finally {
    await booted.cleanup();
  }
});

test('overlapping failures cannot apply repairs in response-completion order', async () => {
  const booted = await bootApp();
  try {
    const step = await openPreview(booted);
    await holdFailures(booted);
    const reads = await holdFirstCalls(booted.app, 'getProject', 2);
    await step.locator('.step-toggle').click();
    await expect
      .poll(() =>
        booted.app.evaluate(
          () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
        ),
      )
      .toBe(1);
    await releaseFailure(booted, 0);
    await expect.poll(reads.count).toBe(1);
    await step.locator('.step-toggle').click();
    await expect
      .poll(() =>
        booted.app.evaluate(
          () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
        ),
      )
      .toBe(2);
    const path = join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('- [ ] First step', '- [!] First step'),
    );
    await releaseFailure(booted, 1);
    await expect.poll(reads.count).toBeGreaterThanOrEqual(2);
    await reads.releaseWithOriginal(1);
    await expectFailure(booted, 1);
    await expect(step).toHaveClass(/step-marker-blocked/);
    await reads.releaseWithOriginal(0);
    await expectFailure(booted, 0);
    await expect(step).toHaveClass(/step-marker-blocked/);
  } finally {
    await booted.cleanup();
  }
});

test('shifted steps settle from a real read instead of restoring a stale line marker', async () => {
  const booted = await bootApp();
  try {
    const step = await openPreview(booted);
    await holdToggle(booted);
    await step.locator('.step-toggle').click();
    await expect
      .poll(() =>
        booted.app.evaluate(
          () => (globalThis as unknown as { toggleCalls: unknown[] }).toggleCalls.length,
        ),
      )
      .toBe(1);
    const path = join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md');
    const shifted = (await readFile(path, 'utf8'))
      .replace('## Steps\n', '## Steps\n\nInserted prose.\n')
      .replace('- [ ] First step', '- [!] First step shifted');
    await writeFile(path, shifted);
    await releaseToggle(booted);
    await expect(booted.window.locator('.toast')).toContainText('Line 11 is not a step');
    await expect(
      booted.window.locator('.step').filter({ hasText: 'First step shifted' }),
    ).toHaveClass(/step-marker-blocked/);
    expect(await readFile(path, 'utf8')).toBe(shifted);
  } finally {
    await booted.cleanup();
  }
});

for (const rejectBeforeRead of [false, true]) {
  test(`conception departure/return cancels ${rejectBeforeRead ? 'an old intent before its late rejection' : 'a held repair response'}`, async () => {
    const booted = await bootApp({
      prepare: async (root) => {
        await mkdir(join(root, 'local-next', '.condash'), { recursive: true });
        await writeFile(join(root, 'local-next', '.condash', 'settings.json'), '{}');
      },
    });
    try {
      const step = await openPreview(booted);
      await holdFailures(booted);
      const reads = await holdFirstCalls(booted.app, 'getProject', rejectBeforeRead ? 0 : 1);
      await step.locator('.step-toggle').click();
      await expect
        .poll(() =>
          booted.app.evaluate(
            () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
          ),
        )
        .toBe(1);
      if (!rejectBeforeRead) {
        await releaseFailure(booted, 0);
        await expect.poll(reads.count).toBe(1);
      }
      for (const path of [join(booted.conceptionDir, 'local-next'), booted.conceptionDir]) {
        await booted.app.evaluate(({ BrowserWindow }, path) => {
          BrowserWindow.getAllWindows()[0].webContents.send('menu-open-recent', path);
        }, path);
        await expect(booted.window.locator('.status-bar-path')).toHaveText(path);
      }
      await expect(step).toHaveClass(/step-marker-todo/);
      const before = await reads.count();
      if (rejectBeforeRead) await releaseFailure(booted, 0);
      else await reads.releaseWithOriginal(0);
      await expectFailure(booted, 0);
      expect(await reads.count()).toBe(before);
      await expect(step).toHaveClass(/step-marker-todo/);
    } finally {
      await booted.cleanup();
    }
  });
}

for (const cancelled of [true, false]) {
  test(`${cancelled ? 'cancelled picker' : 'failed conception switch'} refreshes invalidated optimism in the unchanged context`, async () => {
    const booted = await bootApp();
    try {
      const step = await openPreview(booted);
      await holdFailures(booted);
      const reads = await holdFirstCalls(booted.app, 'getProject', 0);
      await booted.app.evaluate(({ ipcMain }, cancelled) => {
        (
          ipcMain as unknown as { _invokeHandlers: Map<string, () => Promise<unknown>> }
        )._invokeHandlers.set('pickConceptionPath', async () => {
          if (cancelled) return null;
          throw new Error('Held conception selection failure');
        });
      }, cancelled);
      await step.locator('.step-toggle').click();
      await expect
        .poll(() =>
          booted.app.evaluate(
            () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
          ),
        )
        .toBe(1);
      await sendMenu(booted.app, 'open-folder');
      await expect(step).toHaveClass(/step-marker-todo/);
      await releaseFailure(booted, 0);
      await expectFailure(booted, 0);
      expect(await reads.count()).toBe(0);
      await expect(step).toHaveClass(/step-marker-todo/);
    } finally {
      await booted.cleanup();
    }
  });
}

test('repair read failure restores the pre-optimism snapshot and explicitly reports stale fallback', async () => {
  const booted = await bootApp();
  try {
    const step = await openPreview(booted);
    await holdFailures(booted);
    await booted.app.evaluate(({ ipcMain }) => {
      (
        ipcMain as unknown as { _invokeHandlers: Map<string, () => Promise<unknown>> }
      )._invokeHandlers.set('getProject', async () => {
        throw new Error('Held repair read failure');
      });
    });
    await step.locator('.step-toggle').click();
    await expect
      .poll(() =>
        booted.app.evaluate(
          () => (globalThis as unknown as { failedToggles: unknown[] }).failedToggles.length,
        ),
      )
      .toBe(1);
    await releaseFailure(booted, 0);
    await expect(booted.window.locator('.toast')).toContainText('Steps reload failed:');
    await expect(booted.window.locator('.toast')).toContainText(
      'Showing previous snapshot; refresh to retry.',
    );
    await expect(step).toHaveClass(/step-marker-todo/);
    expect(
      await readFile(
        join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md'),
        'utf8',
      ),
    ).toContain('- [ ] First step');
  } finally {
    await booted.cleanup();
  }
});

test('rapid preview toggles keep their individual expected markers', async () => {
  const booted = await bootApp();
  try {
    await booted.window.locator('.row').filter({ hasText: 'Sample project' }).first().click();
    await holdToggle(booted);
    const step = booted.window.locator('.step').filter({ hasText: 'First step' });
    await step.locator('.step-toggle').evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(step).toHaveClass(/step-marker-done/);
    await expect
      .poll(async () =>
        booted.app.evaluate(() =>
          (globalThis as unknown as { toggleCalls: unknown[][] }).toggleCalls.map((call) =>
            call.slice(2),
          ),
        ),
      )
      .toEqual([
        [' ', '~'],
        ['~', 'x'],
      ]);
    await releaseToggle(booted);
    const path = join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md');
    await expect.poll(() => readFile(path, 'utf8')).toContain('- [x] First step');
    await expect(booted.window.locator('.toast')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('card-opened preview toggles without manufacturing drift', async () => {
  const booted = await bootApp();
  try {
    await booted.window.locator('.row').filter({ hasText: 'Sample project' }).first().click();
    const step = booted.window.locator('.step').filter({ hasText: 'First step' });
    await step.locator('.step-toggle').click();
    await expect(step).toHaveClass(/step-marker-doing/);
    const path = join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md');
    await expect.poll(() => readFile(path, 'utf8')).toContain('- [~] First step');
    await expect(booted.window.locator('.toast')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('toggleStep cycles a marker and rewrites the line on disk', async () => {
  const booted = await bootApp();
  try {
    const path = join(
      booted.conceptionDir,
      'projects',
      '2026-04',
      '2026-04-26-sample',
      'README.md',
    );
    const project = await booted.window.evaluate(({ p }) => window.condash.getProject(p), {
      p: path,
    });
    expect(project).not.toBeNull();
    const step = project!.steps[0];
    expect(step.marker).toBe(' ');

    await booted.window.evaluate(
      ({ p, lineIndex, expected, next }) => window.condash.toggleStep(p, lineIndex, expected, next),
      { p: path, lineIndex: step.lineIndex, expected: ' ' as const, next: '~' as const },
    );

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('- [~] First step');
  } finally {
    await booted.cleanup();
  }
});

test('a shifted stale line is refused without changing the README', async () => {
  const booted = await bootApp();
  try {
    const path = join(booted.conceptionDir, 'projects/2026-04/2026-04-26-sample/README.md');
    const project = await booted.window.evaluate((path) => window.condash.getProject(path), path);
    const shifted = (await readFile(path, 'utf8')).replace(
      '## Steps\n',
      '## Steps\n\nInserted prose.\n',
    );
    await writeFile(path, shifted);
    const error = await booted.window.evaluate(
      async ({ path, lineIndex }) => {
        try {
          await window.condash.toggleStep(path, lineIndex, ' ', '~');
          return null;
        } catch (error) {
          return (error as Error).message;
        }
      },
      { path, lineIndex: project!.steps[0].lineIndex },
    );
    expect(error).toContain('Line 11 is not a step');
    expect(await readFile(path, 'utf8')).toBe(shifted);
  } finally {
    await booted.cleanup();
  }
});
