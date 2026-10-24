import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

async function fixture() {
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { shell: '/bin/bash', memory: { enabled: false } },
    },
    prepare: async (root) => {
      await mkdir(join(root, 'resources'));
      await writeFile(join(root, 'resources', 'guide.md'), '# Synthetic guide');
      await writeFile(join(root, 'resources', 'other.md'), '# Replacement document');
    },
  });
  const { app, window, conceptionDir } = booted;
  await window.setViewportSize({ width: 1280, height: 1000 });
  await window.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
  await app.evaluate(({ ipcMain, shell }) => {
    const state = { resolves: 0, writes: [] as string[], external: [] as string[] };
    (globalThis as any).__documentHover = state;
    const handlers = (ipcMain as any)._invokeHandlers;
    for (const channel of ['termResolveDocument', 'termWrite']) {
      const original = handlers.get(channel);
      handlers.set(channel, (event: unknown, ...args: any[]) => {
        if (channel === 'termResolveDocument') state.resolves++;
        else state.writes.push(args[1]);
        return original(event, ...args);
      });
    }
    shell.openExternal = async (uri) => {
      state.external.push(uri);
    };
  });
  const spawned = await window.evaluate(
    ({ cwd, script }) =>
      window.condash.termSpawn({
        side: 'my',
        cwd,
        command: `exec node '${script}'`,
      }),
    {
      cwd: join(conceptionDir, 'resources'),
      script: resolve(__dirname, 'fixtures/document-links-tui.mjs'),
    },
  );
  await expect
    .poll(() =>
      window.evaluate((id) => {
        const term = window.__condashXterms?.get(id);
        return (
          term?.buffer.active.getLine(term.buffer.active.viewportY + 1)?.translateToString() ?? ''
        );
      }, spawned.id),
    )
    .toContain('Read the guide');
  await expect
    .poll(() =>
      window.evaluate(() => {
        const counts = window.__condashRepaints;
        return !!counts && counts.started === counts.settled;
      }),
    )
    .toBe(true);
  const position = await window.evaluate((id) => {
    const term = window.__condashXterms!.get(id)!;
    const screen = term.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
    return {
      x: screen.left + (screen.width * 2.5) / term.cols,
      y: screen.top + (screen.height * 1.5) / term.rows,
    };
  }, spawned.id);
  await window.mouse.move(position.x, position.y);
  await expect(window.locator('.xterm-screen.xterm-cursor-pointer')).toHaveCount(1);
  return { ...booted, id: spawned.id };
}

async function state(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (globalThis as any).__documentHover as {
        resolves: number;
        writes: string[];
        external: string[];
      },
  );
}

function buttonReports(writes: string[]): string[] {
  return writes.filter((write) =>
    [...write.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)].some((match) => (Number(match[1]) & 32) === 0),
  );
}

async function repaint(window: Page, id: string, uri = 'guide.md', label = 'Read the guide') {
  await window.evaluate(
    async ({ id, uri, label }) => {
      const term = window.__condashXterms!.get(id)!;
      await new Promise<void>((resolve) =>
        term.write(`\x1b[2;1H\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\\x1b[K`, resolve),
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    },
    { id, uri, label },
  );
}

test('an unchanged OSC hyperlink repaint preserves the owned down/up click', async () => {
  const { app, window, id, cleanup } = await fixture();
  try {
    await window.mouse.down();
    await repaint(window, id);
    await window.mouse.up();
    await expect(window.locator('.note-modal')).toBeVisible();
    await expect(window.locator('.note-modal')).toContainText('Synthetic guide');
    const captured = await state(app);
    expect(captured.resolves).toBe(1);
    expect(buttonReports(captured.writes)).toEqual([]);
    expect(captured.external).toEqual([]);
    await window.screenshot({ path: test.info().outputPath('hover-renewal.png') });
  } finally {
    await cleanup();
  }
});

for (const duringGesture of [false, true]) {
  test(`blur ${duringGesture ? 'during a gesture cancels it and' : 'while idle'} preserves the next same-cell click`, async () => {
    const { app, window, cleanup } = await fixture();
    try {
      if (duringGesture) await window.mouse.down();
      await window.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (duringGesture) await window.mouse.up();
      expect((await state(app)).resolves).toBe(0);
      await window.mouse.down();
      await window.mouse.up();
      await expect(window.locator('.note-modal')).toBeVisible();
      const captured = await state(app);
      expect(captured.resolves).toBe(1);
      expect(buttonReports(captured.writes)).toEqual([]);
      expect(captured.external).toEqual([]);
      await window.screenshot({ path: test.info().outputPath('blur-same-cell.png') });
    } finally {
      await cleanup();
    }
  });
}

for (const replacement of [
  { uri: 'other.md', label: 'Read the guide', name: 'URI' },
  { uri: 'guide.md', label: 'Read guide', name: 'range' },
]) {
  test(`a changed hyperlink ${replacement.name} cancels an owned click after repaint`, async () => {
    const { app, window, id, cleanup } = await fixture();
    try {
      await window.mouse.down();
      await repaint(window, id, replacement.uri, replacement.label);
      await window.mouse.up();
      await window.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      await expect(window.locator('.note-modal')).toHaveCount(0);
      const captured = await state(app);
      expect(captured.resolves).toBe(0);
      expect(buttonReports(captured.writes)).toEqual([]);
      expect(captured.external).toEqual([]);
    } finally {
      await cleanup();
    }
  });
}
