import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

async function fixture() {
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { shell: '/bin/bash', memory: { enabled: false } },
    },
  });
  const { app, window, conceptionDir } = booted;
  await window.setViewportSize({ width: 1280, height: 1000 });
  await window.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
  await app.evaluate(({ shell, ipcMain }) => {
    const state = { external: [] as string[], writes: [] as string[] };
    (globalThis as any).__webLinks = state;
    const handlers = (ipcMain as any)._invokeHandlers;
    const original = handlers.get('termWrite');
    handlers.set('termWrite', (event: unknown, ...args: any[]) => {
      state.writes.push(args[1]);
      return original(event, ...args);
    });
    shell.openExternal = async (uri) => {
      state.external.push(uri);
    };
  });
  const inputLog = join(conceptionDir, 'web-input.jsonl');
  await writeFile(inputLog, '');
  const spawned = await window.evaluate(
    ({ cwd, script, inputLog }) =>
      window.condash.termSpawn({ side: 'my', cwd, command: `exec node '${script}' '${inputLog}'` }),
    { cwd: conceptionDir, script: resolve(__dirname, 'fixtures/web-links-tui.mjs'), inputLog },
  );
  const id = spawned.id;
  await expect.poll(() => grid(window, id)).toContain('Visit the website');
  await expect
    .poll(() =>
      window.evaluate(() => {
        const counts = window.__condashRepaints;
        return !!counts && counts.started === counts.settled;
      }),
    )
    .toBe(true);
  await window.evaluate(() => {
    (window as any).__webTrusted = [];
    window.addEventListener(
      'mousedown',
      (event) => (window as any).__webTrusted.push(event.isTrusted),
      true,
    );
  });
  const reset = async () => {
    await app.evaluate(() => {
      const state = (globalThis as any).__webLinks;
      state.external = [];
      state.writes = [];
    });
    await writeFile(inputLog, '');
  };
  const snapshot = async () => {
    // A real PTY receipt after the mouse IPCs is the zero-button-byte barrier.
    const receipts = (await received(inputLog)).split('\x00').length;
    await window.evaluate((id) => window.condash.termWrite(id, '\x00'), id);
    await expect
      .poll(async () => (await received(inputLog)).split('\x00').length)
      .toBeGreaterThan(receipts);
    const state = await app.evaluate(
      () => (globalThis as any).__webLinks as { external: string[]; writes: string[] },
    );
    return { ...state, received: await received(inputLog) };
  };
  return { ...booted, id, reset, snapshot };
}

async function received(path: string): Promise<string> {
  const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
  return lines.map((line) => Buffer.from(JSON.parse(line)).toString()).join('');
}
function buttonReports(bytes: string): string[] {
  return [...bytes.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)]
    .filter((match) => (Number(match[1]) & 32) === 0)
    .map((match) => match[0]);
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
async function hover(window: Page, id: string, label = 'Visit the website') {
  const point = await window.evaluate(
    ({ id, label }) => {
      const term = window.__condashXterms!.get(id)!;
      const rect = term.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
      for (let row = 0; row < term.rows; row++) {
        const column =
          term.buffer.active
            .getLine(term.buffer.active.viewportY + row)
            ?.translateToString()
            .indexOf(label) ?? -1;
        if (column >= 0)
          return {
            x: rect.left + (rect.width * (column + 1.5)) / term.cols,
            y: rect.top + (rect.height * (row + 0.5)) / term.rows,
            offX: rect.right - 5,
            offY: rect.top + (rect.height * 0.5) / term.rows,
          };
      }
      throw new Error(`Missing label: ${label}`);
    },
    { id, label },
  );
  await window.mouse.move(point.offX, point.offY);
  await window.mouse.move(point.x, point.y);
  await expect(window.locator('.xterm-screen.xterm-cursor-pointer')).toHaveCount(1);
  return point;
}
async function click(window: Page, modifiers: string[] = []) {
  for (const modifier of modifiers) await window.keyboard.down(modifier);
  await window.mouse.down();
  await window.mouse.up();
  for (const modifier of [...modifiers].reverse()) await window.keyboard.up(modifier);
}
async function fixtureCommand(window: Page, id: string, command: string) {
  const previous = Number((await grid(window, id)).match(/Fixture ACK (\d+):/)?.[1] ?? 0);
  await window.evaluate(({ id, command }) => window.condash.termWrite(id, command), {
    id,
    command,
  });
  await expect.poll(() => grid(window, id)).toContain(`Fixture ACK ${previous + 1}:${command}`);
  // The unique output token follows the command's data in the parsed buffer.
  // Allow its resulting link leave/hover renewal to render before releasing.
  await window.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}
async function mode(window: Page, id: string, reporting: boolean) {
  await fixtureCommand(window, id, reporting ? 'r' : 's');
  await expect
    .poll(() =>
      window.evaluate((id) => window.__condashXterms!.get(id)!.modes.mouseTrackingMode, id),
    )
    .toBe(reporting ? 'vt200' : 'none');
  if (reporting) await expect.poll(() => grid(window, id)).toContain('Visit the website');
}

test('real PTY labelled web links own Ctrl/Meta exactly once in reporting and ordinary shells', async () => {
  test.setTimeout(90_000);
  const { app, window, id, reset, snapshot, cleanup } = await fixture();
  try {
    for (const reporting of [true, false]) {
      await mode(window, id, reporting);
      for (const [label, uri] of [
        ['Visit the website', 'https://example.com'],
        ['Visit HTTP', 'http://example.com'],
        ['Send mail', 'mailto:test@example.com'],
        ['final web segment', 'https://example.com/wrapped'],
      ]) {
        for (const modifiers of [
          [],
          ['Control'],
          ['Meta'],
          ['Control', 'Meta'],
          ['Control', 'Alt'],
        ]) {
          await hover(window, id, label);
          await reset();
          await click(window, modifiers);
          const evidence = await snapshot();
          console.log(JSON.stringify({ reporting, label, modifiers, ...evidence }));
          expect(evidence.external).toEqual(reporting && !modifiers.length ? [] : [uri]);
          if (reporting && !modifiers.length)
            expect(buttonReports(evidence.received)).toHaveLength(2);
          else expect(buttonReports(evidence.received)).toEqual([]);
          if (reporting && modifiers.length)
            expect(buttonReports(evidence.writes.join(''))).toEqual([]);
        }
      }
      for (const label of ['Unsupported scheme', 'Near-miss scheme']) {
        await hover(window, id, label);
        await reset();
        await click(window, ['Control']);
        expect((await snapshot()).external).toEqual([]);
      }
      await hover(window, id, 'https://example.org/bare');
      await reset();
      await click(window);
      expect((await snapshot()).external).toEqual(['https://example.org/bare']);
    }
    const trusted = await window.evaluate(() => (window as any).__webTrusted as boolean[]);
    expect(trusted.length).toBeGreaterThan(40);
    expect(trusted.every(Boolean)).toBe(true);
    expect(await app.evaluate(() => (globalThis as any).__webLinks.external.length)).toBe(1);
  } finally {
    await cleanup();
  }
});

test('web selection, modified drag replay, move-off and Alt-only stay on the terminal path', async () => {
  const { window, id, reset, snapshot, cleanup } = await fixture();
  try {
    for (const modifiers of [['Shift'], ['Control', 'Shift'], ['Meta', 'Shift']]) {
      const point = await hover(window, id);
      await reset();
      for (const modifier of modifiers) await window.keyboard.down(modifier);
      await window.mouse.down();
      await window.mouse.move(point.x + 65, point.y, { steps: 8 });
      await window.mouse.up();
      for (const modifier of modifiers.reverse()) await window.keyboard.up(modifier);
      expect(
        await window.evaluate((id) => window.__condashXterms!.get(id)!.getSelection(), id),
      ).toBeTruthy();
      const evidence = await snapshot();
      expect(evidence.external).toEqual([]);
      expect(buttonReports(evidence.received)).toEqual([]);
    }
    for (const modifiers of [[], ['Control'], ['Meta']]) {
      const point = await hover(window, id);
      await reset();
      for (const modifier of modifiers) await window.keyboard.down(modifier);
      await window.mouse.down();
      await window.mouse.move(point.x + 55, point.y, { steps: 8 });
      await window.mouse.up();
      for (const modifier of modifiers) await window.keyboard.up(modifier);
      const evidence = await snapshot();
      expect(evidence.external).toEqual([]);
      expect(buttonReports(evidence.received)).toHaveLength(2);
      // The replay starts at the original column, not the first moved column.
      expect(buttonReports(evidence.received)[0]).toMatch(/;2;2M$/);
    }
    const point = await hover(window, id);
    await reset();
    await window.keyboard.down('Control');
    await window.mouse.down();
    await window.mouse.move(point.x, point.y + 20, { steps: 4 });
    await window.mouse.up();
    await window.keyboard.up('Control');
    expect((await snapshot()).external).toEqual([]);
    await hover(window, id);
    await reset();
    await click(window, ['Alt']);
    const alt = await snapshot();
    expect(buttonReports(alt.received)).toHaveLength(2);
    expect(alt.external).toEqual(['https://example.com']);
    await mode(window, id, false);
    const start = await hover(window, id);
    await reset();
    await window.mouse.down();
    await window.mouse.move(start.x + 65, start.y, { steps: 8 });
    await window.mouse.up();
    expect(
      await window.evaluate((id) => window.__condashXterms!.get(id)!.getSelection(), id),
    ).toBeTruthy();
  } finally {
    await cleanup();
  }
});

test('web hover renewal, blur, changed targets, scroll and disposal preserve capture lifecycle', async () => {
  const { app, window, id, reset, snapshot, cleanup } = await fixture();
  try {
    for (const command of ['p', 'u', 'g']) {
      await mode(window, id, true);
      await hover(window, id);
      await reset();
      await window.keyboard.down('Control');
      await window.mouse.down();
      await fixtureCommand(window, id, command);
      await expect
        .poll(() => grid(window, id))
        .toContain(command === 'g' ? 'Visit website' : 'Visit the website');
      await window.mouse.up();
      await window.keyboard.up('Control');
      const evidence = await snapshot();
      expect(evidence.external).toEqual(command === 'p' ? ['https://example.com'] : []);
      expect(buttonReports(evidence.received)).toEqual([]);
    }
    await mode(window, id, true);
    await hover(window, id);
    await reset();
    await window.keyboard.down('Meta');
    await window.mouse.down();
    await window.evaluate(() => window.dispatchEvent(new Event('blur')));
    await window.mouse.up();
    expect((await snapshot()).external).toEqual([]);
    await window.mouse.down();
    await window.mouse.up();
    await window.keyboard.up('Meta');
    expect((await snapshot()).external).toEqual(['https://example.com']);
    await hover(window, id);
    await reset();
    await window.keyboard.down('Control');
    await window.mouse.down();
    await fixtureCommand(window, id, 'z');
    await expect.poll(() => grid(window, id)).toContain('Scrolled fixture');
    await window.mouse.up();
    await window.keyboard.up('Control');
    expect((await snapshot()).external).toEqual([]);
    await mode(window, id, true);
    await hover(window, id);
    await reset();
    await window.keyboard.down('Control');
    await window.mouse.down();
    await window.evaluate((id) => window.condash.termClose(id), id);
    await expect
      .poll(() => window.evaluate((id) => window.__condashXterms?.has(id), id))
      .toBe(false);
    await window.mouse.up();
    await window.keyboard.up('Control');
    await expect(window.locator('.note-modal, .mdx-modal')).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).__webLinks.external)).toEqual([]);
  } finally {
    await cleanup();
  }
});

for (const modifier of ['Control', 'Meta']) {
  for (const scenario of ['drag-release-alt', 'drag-mode-off', 'blur-mode-off', 'blur-reporting']) {
    test(`${modifier} captured ${scenario} remains owned through fallback and recovers on genuine downs`, async () => {
      const { window, id, reset, snapshot, cleanup } = await fixture();
      try {
        const point = await hover(window, id);
        // A prior real click establishes the Linkifier's retained down-link.
        await click(window);
        await snapshot();
        await reset();
        await window.keyboard.down(modifier);
        await window.mouse.down();
        if (scenario.startsWith('drag')) {
          await window.mouse.move(point.x + 35, point.y, { steps: 5 });
        } else {
          await window.evaluate(() => window.dispatchEvent(new Event('blur')));
        }
        if (scenario === 'drag-release-alt') {
          await window.keyboard.up(modifier);
          await window.keyboard.down('Alt');
        }
        if (scenario.endsWith('mode-off')) await mode(window, id, false);
        await window.mouse.up();
        await window.keyboard.up(modifier);
        await window.keyboard.up('Alt');
        const evidence = await snapshot();
        console.log(JSON.stringify({ modifier, scenario, ...evidence }));
        expect(evidence.external, 'captured drag/cancel must not activate Linkifier').toEqual([]);
        const buttons = buttonReports(evidence.received);
        expect(buttons).toHaveLength(
          scenario === 'drag-release-alt' ? 2 : scenario === 'drag-mode-off' ? 1 : 0,
        );

        // Suppression must not stick to subsequent uncaptured gestures.
        await mode(window, id, true);
        await hover(window, id);
        await reset();
        await click(window, ['Alt']);
        const alt = await snapshot();
        expect(alt.external).toEqual(['https://example.com']);
        expect(buttonReports(alt.received)).toHaveLength(2);
        await mode(window, id, false);
        for (const modifiers of [[], ['Control'], ['Meta']]) {
          await hover(window, id);
          await reset();
          await click(window, modifiers);
          const ordinary = await snapshot();
          expect(ordinary.external).toEqual(['https://example.com']);
          expect(buttonReports(ordinary.received)).toEqual([]);
        }
        const trusted = await window.evaluate(() => (window as any).__webTrusted as boolean[]);
        // Only the gate's deliberate replayed down for drags is synthetic.
        expect(trusted.filter((value) => !value)).toHaveLength(scenario.startsWith('drag') ? 1 : 0);
      } finally {
        await cleanup();
      }
    });
  }
}
