import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

// Plain absolute paths printed as terminal text (issue #617): the link
// provider underlines an existing path on hover and routes the click — a
// .md/.mdx to the document viewer, any other file through openPath (bounded
// to the workspace roots, refused with a toast outside them), and nothing at
// all for a path that does not exist. OSC 8 labels and bare URLs keep their
// routes and their priority over the provider.

const PROTOCOL_TUI = resolve(__dirname, 'fixtures/path-links-tui.mjs');

async function instrument(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, shell }) => {
    const state = { resolves: 0, external: [] as string[], opened: [] as string[] };
    (globalThis as any).__pathLinks = state;
    const handlers = (ipcMain as any)._invokeHandlers;
    const original = handlers.get('termResolveDocument');
    handlers.set('termResolveDocument', (event: unknown, ...args: any[]) => {
      state.resolves++;
      return original(event, ...args);
    });
    shell.openExternal = async (uri) => {
      state.external.push(uri);
    };
    shell.openPath = async (path) => {
      state.opened.push(path);
      return '';
    };
  });
}

async function state(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (globalThis as any).__pathLinks as {
        resolves: number;
        external: string[];
        opened: string[];
      },
  );
}

async function reset(app: ElectronApplication) {
  await app.evaluate(() => {
    const state = (globalThis as any).__pathLinks;
    state.resolves = 0;
    state.external = [];
    state.opened = [];
  });
}

async function point(window: Page, id: string, label: string) {
  return window.evaluate(
    ({ id, label }) => {
      const term = window.__condashXterms?.get(id);
      if (!term) throw new Error('Terminal not mounted');
      const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!screen) throw new Error('Terminal screen missing');
      for (let row = 0; row < term.rows; row++) {
        const text =
          term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString() ?? '';
        const column = text.indexOf(label);
        if (column >= 0)
          return {
            x: screen.left + ((column + 1.5) / term.cols) * screen.width,
            y: screen.top + ((row + 0.5) / term.rows) * screen.height,
          };
      }
      throw new Error(`Label not visible: ${label}`);
    },
    { id, label },
  );
}

async function grid(window: Page, id: string) {
  return window.evaluate((id) => {
    const term = window.__condashXterms?.get(id);
    if (!term) return '';
    return Array.from(
      { length: term.rows },
      (_, row) =>
        term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ??
        '',
    ).join('\n');
  }, id);
}

async function ready(window: Page, id: string, label: string) {
  await expect.poll(() => grid(window, id), { timeout: 20_000 }).toContain(label);
  await expect
    .poll(() =>
      window.evaluate(() => {
        const counts = window.__condashRepaints;
        return !!counts && counts.started === counts.settled;
      }),
    )
    .toBe(true);
}

async function hoverLabel(window: Page, id: string, label: string) {
  const position = await point(window, id, label);
  await window.mouse.move(position.x, position.y);
  return position;
}

async function clickLabel(window: Page, id: string, label: string) {
  const position = await hoverLabel(window, id, label);
  await expect
    .poll(() =>
      window.evaluate(
        (id) =>
          window.__condashXterms
            ?.get(id)
            ?.element?.querySelector('.xterm-screen')
            ?.classList.contains('xterm-cursor-pointer'),
        id,
      ),
    )
    .toBe(true);
  await window.mouse.down();
  await window.mouse.up();
}

/** Assert the pointer never appears on the hovered label, settling long enough
 *  for the provider's existence probe to have answered first. */
async function expectNoLink(window: Page, id: string) {
  await window.waitForTimeout(500);
  await expect
    .poll(() =>
      window.evaluate(
        (id) =>
          window.__condashXterms
            ?.get(id)
            ?.element?.querySelector('.xterm-screen')
            ?.classList.contains('xterm-cursor-pointer'),
        id,
      ),
    )
    .toBe(false);
}

test('plain terminal paths open by existence: viewer, openPath, outside refusal and unchanged neighbours', async () => {
  test.setTimeout(180_000);
  let docs = '';
  let outside = '';
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { shell: '/bin/bash', memory: { enabled: false } },
    },
    prepare: async (root) => {
      docs = join(root, 'resources');
      await mkdir(docs);
      await writeFile(join(docs, 'note.md'), '# Plain path note\n\nNative Markdown viewer.');
      await writeFile(join(docs, 'chart.png'), 'png');
      await writeFile(join(docs, 'spaced name.md'), 'never linked in v1');
      await writeFile(join(docs, 'guide.md'), '# Synthetic guide\n\nLabelled OSC 8 viewer.');
      outside = await mkdtemp(join(tmpdir(), 'terminal-paths-outside-'));
      await writeFile(join(outside, 'shot.png'), 'png');
    },
  });
  const { window, app, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 1000 });
    await window.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
    await instrument(app);
    const osc = (uri: string, label: string) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
    const spawned = await window.evaluate(
      ({ initialCwd, docs, script, lines }) =>
        window.condash.termSpawn({
          side: 'my',
          cwd: initialCwd,
          command: `cd '${docs}' && PATH_LINES='${JSON.stringify(lines).replaceAll("'", `'\\''`)}' node '${script}'`,
        }),
      {
        initialCwd: resolve(docs, '..'),
        docs,
        script: PROTOCOL_TUI,
        lines: [
          `Note: ${join(docs, 'note.md')}`,
          `Chart: ${join(docs, 'chart.png')}`,
          `Spaced: ${join(docs, 'spaced name.md')}`,
          `Outside: ${join(outside, 'shot.png')}`,
          `Missing: ${join(docs, 'missing.md')}`,
          osc('guide.md', 'Labelled: guide.md'),
          `Bare: https://example.com`,
        ],
      },
    );
    await ready(window, spawned.id, 'Spaced:');

    // An existing .md path opens condash's viewer through the document event.
    await reset(app);
    await clickLabel(window, spawned.id, join(docs, 'note.md'));
    await expect(window.locator('.note-modal')).toBeVisible();
    await expect(window.locator('.note-modal')).toContainText('Native Markdown viewer.');
    expect((await state(app)).resolves).toBe(1);
    expect((await state(app)).opened).toEqual([]);
    expect((await state(app)).external).toEqual([]);
    await window.keyboard.press('Escape');

    // An existing non-document file goes through openPath (stubbed here).
    await ready(window, spawned.id, 'Chart:');
    await reset(app);
    await clickLabel(window, spawned.id, join(docs, 'chart.png'));
    await expect(window.locator('.note-modal, .mdx-modal')).toHaveCount(0);
    await expect.poll(async () => (await state(app)).opened).toHaveLength(1);
    expect((await state(app)).opened[0]).toContain('chart.png');
    expect((await state(app)).resolves).toBe(0);
    expect((await state(app)).external).toEqual([]);

    // A file outside the workspace roots is underlined but refused on click.
    await ready(window, spawned.id, 'Outside:');
    await reset(app);
    await clickLabel(window, spawned.id, join(outside, 'shot.png'));
    await expect(window.locator('.toast')).toContainText('Cannot open terminal file');
    await expect(window.locator('.toast')).toContainText('outside the workspace');
    expect((await state(app)).opened).toEqual([]);
    await expect(window.locator('.note-modal, .mdx-modal')).toHaveCount(0);

    // A nonexistent path never becomes a link: no pointer, no open route.
    await ready(window, spawned.id, 'Missing:');
    await reset(app);
    await hoverLabel(window, spawned.id, join(docs, 'missing.md'));
    await expectNoLink(window, spawned.id);
    await window.mouse.down();
    await window.mouse.up();
    await expect(window.locator('.toast')).toHaveCount(0);
    await expect(window.locator('.note-modal, .mdx-modal')).toHaveCount(0);
    expect((await state(app)).resolves).toBe(0);
    expect((await state(app)).opened).toEqual([]);
    expect((await state(app)).external).toEqual([]);

    // A path whose name contains a space is not detected in v1: the token
    // stops at the whitespace and the truncated prefix does not exist.
    await ready(window, spawned.id, 'Spaced:');
    await reset(app);
    await hoverLabel(window, spawned.id, 'resources/spaced');
    await expectNoLink(window, spawned.id);
    await window.mouse.down();
    await window.mouse.up();
    expect((await state(app)).opened).toEqual([]);
    expect((await state(app)).resolves).toBe(0);

    // The labelled OSC 8 route is unchanged and keeps priority.
    await reset(app);
    await clickLabel(window, spawned.id, 'Labelled: guide.md');
    await expect(window.locator('.note-modal')).toBeVisible();
    await expect(window.locator('.note-modal')).toContainText('Labelled OSC 8 viewer.');
    expect((await state(app)).resolves).toBe(1);
    expect((await state(app)).opened).toEqual([]);
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Bare:');

    // The bare-URL Linkifier callback is unchanged.
    await reset(app);
    await clickLabel(window, spawned.id, 'https://example.com');
    await expect.poll(async () => (await state(app)).external).toEqual(['https://example.com']);
    expect((await state(app)).resolves).toBe(0);
    expect((await state(app)).opened).toEqual([]);
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});
