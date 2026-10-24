import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';

const FORM =
  '<QuestionForm id="choice" questions={[{ id: "next", title: "Choose the next step", mode: "single", options: [{ id: "test", label: "Run synthetic checks" }, { id: "wait", label: "Wait" }] }]} />';
const PROTOCOL_TUI = resolve(__dirname, 'fixtures/document-links-tui.mjs');
const runFile = promisify(execFile);

async function instrument(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, shell }) => {
    const state = { writes: [] as string[], resolves: 0, external: [] as string[] };
    (globalThis as any).__documentLinks = state;
    const handlers = (ipcMain as any)._invokeHandlers;
    for (const channel of ['termWrite', 'termResolveDocument']) {
      const original = handlers.get(channel);
      handlers.set(channel, (event: unknown, ...args: any[]) => {
        if (channel === 'termWrite') state.writes.push(args[1]);
        else state.resolves++;
        return original(event, ...args);
      });
    }
    shell.openExternal = async (uri) => {
      state.external.push(uri);
    };
  });
}

async function state(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (globalThis as any).__documentLinks as {
        writes: string[];
        resolves: number;
        external: string[];
      },
  );
}

async function reset(app: ElectronApplication) {
  await app.evaluate(() => {
    const state = (globalThis as any).__documentLinks;
    state.writes = [];
    state.resolves = 0;
    state.external = [];
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

function buttonReports(writes: string[]): string[] {
  return writes.filter((write) =>
    [...write.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)].some((match) => (Number(match[1]) & 32) === 0),
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

async function clickLabel(window: Page, id: string, label: string) {
  const position = await point(window, id, label);
  await window.mouse.move(position.x, position.y);
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

test('labelled OSC documents own one click, preserve gestures, and open native viewers safely', async () => {
  test.setTimeout(90_000);
  let docs = '';
  const outside = await mkdtemp(join(tmpdir(), 'terminal-links-outside-'));
  await writeFile(join(outside, 'outside.md'), '# Synthetic outside file');
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { shell: '/bin/bash', memory: { enabled: false } },
    },
    prepare: async (root) => {
      docs = join(root, 'resources');
      await mkdir(docs);
      await writeFile(join(docs, 'guide.md'), '# Synthetic guide\n\nNative Markdown viewer.');
      await writeFile(join(docs, 'decision.mdx'), FORM);
      await symlink(join(outside, 'outside.md'), join(docs, 'escape.md'));
    },
  });
  const { window, app, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 1000 });
    await window.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
    await instrument(app);
    const spawned = await window.evaluate(
      ({ cwd, initialCwd, script }) =>
        window.condash.termSpawn({
          side: 'my',
          cwd: initialCwd,
          command: `cd '${cwd}' && exec node '${script}'`,
        }),
      { cwd: docs, initialCwd: resolve(docs, '..'), script: PROTOCOL_TUI },
    );
    await ready(window, spawned.id, 'Read the guide');
    await reset(app);
    await clickLabel(window, spawned.id, 'Read the guide');
    await expect(window.locator('.note-modal')).toBeVisible();
    await expect(window.locator('.note-modal')).toContainText('Native Markdown viewer.');
    expect(await state(app)).toEqual({ writes: [], resolves: 1, external: [] });
    await window.screenshot({ path: test.info().outputPath('native-markdown.png') });
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Answer the form');
    await reset(app);
    await clickLabel(window, spawned.id, 'Answer the form');
    await expect(window.locator('.mdx-modal')).toBeVisible();
    expect(await state(app)).toEqual({ writes: [], resolves: 1, external: [] });
    await window
      .locator('.plan-option', { hasText: 'Run synthetic checks' })
      .locator('input')
      .check();
    await sendMenu(app, 'toggle-terminal');
    await ready(window, spawned.id, 'Read the guide');
    await reset(app);
    await clickLabel(window, spawned.id, 'Read the guide');
    await expect(window.locator('.mdx-modal')).toBeVisible();
    await expect(
      window.locator('.plan-option', { hasText: 'Run synthetic checks' }).locator('input'),
    ).toBeChecked();
    expect((await state(app)).resolves).toBe(0);
    await window.locator('.mdx-modal [aria-label="Save answers"]').click();
    await expect
      .poll(() => readFile(join(docs, 'decision.mdx'), 'utf8'))
      .toContain('answer: "test"');
    await window.screenshot({ path: test.info().outputPath('interactive-mdx.png') });
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Visit the website');
    await reset(app);
    await clickLabel(window, spawned.id, 'Visit the website');
    expect((await state(app)).external).toEqual([]);
    expect((await state(app)).resolves).toBe(0);
    expect((await state(app)).writes.join('')).toContain('\x1b[<0;');
    await window.keyboard.down('Control');
    await clickLabel(window, spawned.id, 'Visit the website');
    await window.keyboard.up('Control');
    await expect.poll(async () => (await state(app)).external).toEqual(['https://example.com']);

    for (const label of ['Outside document', 'Symlink escape', 'Missing document']) {
      await reset(app);
      await clickLabel(window, spawned.id, label);
      await expect(window.locator('.toast')).toContainText('Cannot open terminal document');
      expect((await state(app)).external).toEqual([]);
      await expect(window.locator('.note-modal, .mdx-modal')).toHaveCount(0);
    }
    for (const label of ['Malformed target', 'Unsupported scheme']) {
      await reset(app);
      await clickLabel(window, spawned.id, label);
      expect((await state(app)).resolves).toBe(0);
      expect((await state(app)).external).toEqual([]);
    }

    await reset(app);
    const start = await point(window, spawned.id, 'Read the guide');
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 65, start.y, { steps: 8 });
    await window.mouse.up();
    expect((await state(app)).resolves).toBe(0);
    expect((await state(app)).writes.join('')).toContain('\x1b[<0;');
    await expect(window.locator('.note-modal, .mdx-modal')).toHaveCount(0);

    await reset(app);
    await window.keyboard.down('Shift');
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 65, start.y, { steps: 8 });
    await window.mouse.up();
    await window.keyboard.up('Shift');
    expect(
      await window.evaluate((id) => window.__condashXterms?.get(id)?.getSelection(), spawned.id),
    ).toBeTruthy();
    expect((await state(app)).resolves).toBe(0);

    await window.keyboard.down('Control');
    await clickLabel(window, spawned.id, 'Read the guide');
    await window.keyboard.up('Control');
    await expect(window.locator('.note-modal')).toBeVisible();
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Wrapped label');
    await clickLabel(window, spawned.id, 'continuation');
    await expect(window.locator('.note-modal')).toBeVisible();
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Read the guide');
    await window.evaluate((id) => window.condash.termWrite(id, 's'), spawned.id);
    await expect
      .poll(() =>
        window.evaluate(
          (id) => window.__condashXterms?.get(id)?.modes.mouseTrackingMode,
          spawned.id,
        ),
      )
      .toBe('none');
    await reset(app);
    const textStart = await point(window, spawned.id, 'Read the guide');
    await window.mouse.move(textStart.x, textStart.y);
    await window.mouse.down();
    await window.mouse.move(textStart.x + 65, textStart.y, { steps: 8 });
    await window.mouse.up();
    expect(
      await window.evaluate((id) => window.__condashXterms?.get(id)?.getSelection(), spawned.id),
    ).toBeTruthy();
    expect((await state(app)).resolves).toBe(0);
    await reset(app);
    await clickLabel(window, spawned.id, 'Visit the website');
    await expect.poll(async () => (await state(app)).external).toEqual(['https://example.com']);
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('installed OpenCode labelled links open native viewers without a TUI click or external launch', async () => {
  const binary = process.env.CONDASH_OPENCODE_BINARY;
  test.skip(!binary, 'Set CONDASH_OPENCODE_BINARY to exercise an isolated installed OpenCode');
  test.setTimeout(120_000);
  let docs = '';
  let wrapper = '';
  let browserLog = '';
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { shell: '/bin/bash', memory: { enabled: false } },
    },
    prepare: async (root) => {
      docs = join(root, 'resources');
      const home = join(root, '.opencode-fixture');
      await mkdir(docs);
      await mkdir(home);
      browserLog = join(home, 'browser.log');
      await writeFile(browserLog, '');
      const browser = join(home, 'fixture-browser');
      await writeFile(browser, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${browserLog}'\n`, {
        mode: 0o700,
      });
      await writeFile(
        join(docs, 'guide.md'),
        '# Synthetic guide\n\nNative Markdown from OpenCode.',
      );
      await writeFile(join(docs, 'decision.mdx'), FORM);
      const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        SHELL: '/bin/bash',
        OPENCODE_TEST_HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_STATE_HOME: join(home, 'state'),
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        BROWSER: browser,
      };
      const now = Date.now();
      const session = 'ses_terminal_document_fixture';
      const data = {
        info: {
          id: session,
          projectID: 'global',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now, idle: now },
          title: 'Document link fixture',
          location: { directory: docs },
        },
        messages: [
          {
            id: 'msg_fixture',
            type: 'assistant',
            time: { created: now, completed: now },
            agent: 'build',
            model: { providerID: 'fixture', id: 'offline' },
            finish: 'stop',
            content: [
              {
                type: 'text',
                text:
                  'Choose [Read the guide](guide.md), [Answer the form](decision.mdx), or [Visit the website](https://example.com).\n\n[Wrapped decision link ' +
                  'segment '.repeat(36) +
                  'final segment](decision.mdx)',
              },
            ],
          },
        ],
      };
      const imported = join(home, 'session.json');
      await writeFile(imported, JSON.stringify(data));
      const result = await runFile(
        binary!,
        ['session', 'import', imported, '--standalone', '--directory', docs],
        { env, cwd: docs, timeout: 60_000 },
      );
      expect(result.stdout).toContain(`Imported session: ${session}`);
      wrapper = join(home, 'launch.sh');
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      const assignments = Object.entries({ ...env, TERM: 'xterm-256color' })
        .map(([key, value]) => `${key}=${quote(value)}`)
        .join(' ');
      await writeFile(
        wrapper,
        `#!/bin/sh\nexec env -i ${assignments} FORCE_HYPERLINK="$FORCE_HYPERLINK" ${quote(binary!)} --standalone --session ${session} ${quote(docs)}\n`,
        { mode: 0o700 },
      );
    },
  });
  const { window, app, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 1000 });
    await window.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
    await instrument(app);
    const spawned = await window.evaluate(
      ({ cwd, wrapper }) =>
        window.condash.termSpawn({ side: 'my', cwd, command: `exec '${wrapper}'` }),
      { cwd: docs, wrapper },
    );
    await ready(window, spawned.id, 'Read the guide');
    await window.screenshot({ path: test.info().outputPath('opencode-labelled-links.png') });
    await reset(app);
    await clickLabel(window, spawned.id, 'Read the guide');
    await expect(window.locator('.note-modal')).toBeVisible();
    await expect(window.locator('.note-modal')).toContainText('Native Markdown from OpenCode.');
    expect((await state(app)).resolves).toBe(1);
    expect((await state(app)).external).toEqual([]);
    expect(buttonReports((await state(app)).writes)).toEqual([]);
    expect(await readFile(browserLog, 'utf8')).toBe('');
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Answer the form');
    await reset(app);
    await clickLabel(window, spawned.id, 'Answer the form');
    await expect(window.locator('.mdx-modal')).toBeVisible();
    expect((await state(app)).resolves).toBe(1);
    expect((await state(app)).external).toEqual([]);
    expect(buttonReports((await state(app)).writes)).toEqual([]);
    expect(await readFile(browserLog, 'utf8')).toBe('');
    await window
      .locator('.plan-option', { hasText: 'Run synthetic checks' })
      .locator('input')
      .check();
    await window.keyboard.press('Control+s');
    await expect
      .poll(() => readFile(join(docs, 'decision.mdx'), 'utf8'))
      .toContain('answer: "test"');
    await window.screenshot({ path: test.info().outputPath('opencode-native-form.png') });
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Answer the form');
    expect(await grid(window, spawned.id)).not.toMatch(/Only http|Failed to open|Unsupported URL/);
    await reset(app);
    const start = await point(window, spawned.id, 'Read the guide');
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 65, start.y, { steps: 8 });
    await window.mouse.up();
    expect((await state(app)).resolves).toBe(0);
    expect(buttonReports((await state(app)).writes).length).toBeGreaterThan(0);
    expect(await grid(window, spawned.id)).not.toMatch(/Only http|Failed to open|Unsupported URL/);
    await reset(app);
    await window.keyboard.down('Control');
    await clickLabel(window, spawned.id, 'Read the guide');
    await window.keyboard.up('Control');
    await expect(window.locator('.note-modal')).toBeVisible();
    expect(buttonReports((await state(app)).writes)).toEqual([]);
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'final segment');
    await reset(app);
    await clickLabel(window, spawned.id, 'final segment');
    await expect(window.locator('.mdx-modal')).toBeVisible();
    expect(buttonReports((await state(app)).writes)).toEqual([]);
    await window.keyboard.press('Escape');
    await ready(window, spawned.id, 'Visit the website');
    await reset(app);
    await clickLabel(window, spawned.id, 'Visit the website');
    await expect.poll(() => readFile(browserLog, 'utf8')).toContain('https://example.com');
    expect((await state(app)).external).toEqual([]);
    expect((await readFile(browserLog, 'utf8')).trim().split('\n')).toEqual([
      'https://example.com/',
    ]);
    expect((await state(app)).resolves).toBe(0);
    await reset(app);
    await window.keyboard.down('Control');
    await clickLabel(window, spawned.id, 'Visit the website');
    await window.keyboard.up('Control');
    await expect.poll(async () => (await state(app)).external).toEqual(['https://example.com']);
    expect((await readFile(browserLog, 'utf8')).trim().split('\n')).toEqual([
      'https://example.com/',
    ]);
  } finally {
    await cleanup();
  }
});
