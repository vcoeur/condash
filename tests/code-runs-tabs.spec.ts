import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bootApp } from './fixtures/electron-app';

const execFileAsync = promisify(execFile);
const repoNames = ['cedar', 'amber', 'fable', 'birch', 'delta', 'elm'];
const phase = process.env.CONDASH_CODE_RUNS_PHASE ?? 'after';
const evidenceDir = process.env.CONDASH_CODE_RUNS_EVIDENCE;

async function seedRuns(root: string): Promise<void> {
  for (const name of repoNames) {
    const path = join(root, 'workspace', name);
    await mkdir(path, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main', path]);
    await writeFile(
      join(path, 'run.sh'),
      `printf 'READY:${name} PID:%s\\n' "$$"
tick=0
while :; do
  printf '${name} tick:%s\\n' "$tick"
  tick=$((tick + 1))
  if read -r -t 0.25 input; then
    if [ "$input" = exit ]; then exit 7; fi
  fi
done
`,
    );
  }
  await writeFile(
    join(root, '.condash', 'settings.json'),
    JSON.stringify({
      workspace_path: join(root, 'workspace'),
      worktrees_path: join(root, 'worktrees'),
      repositories: repoNames.map((name) => ({ name, run: '/bin/bash ./run.sh' })),
    }),
  );
}

async function capture(page: Page, theme: string, name: string): Promise<void> {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: join(evidenceDir, `${phase}-${theme}-${name}.png`) });
}

async function terminalText(page: Page, id: string): Promise<string> {
  return page.evaluate((id) => {
    const term = window.__condashXterms?.get(id);
    if (!term) return '';
    const buffer = term.buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString() ?? '',
    ).join('\n');
  }, id);
}

async function expectFullPanel(page: Page, selector: string): Promise<void> {
  const geometry = await page.evaluate((selector) => {
    const pane = document.querySelector('.repos-pane')!.getBoundingClientRect();
    const header = document.querySelector('.repos-pane > .pane-header')!.getBoundingClientRect();
    const panel = document.querySelector(selector)!.getBoundingClientRect();
    return {
      top: panel.top - header.bottom,
      bottom: pane.bottom - panel.bottom,
      height: panel.height,
    };
  }, selector);
  expect(Math.abs(geometry.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.bottom)).toBeLessThanOrEqual(1);
  expect(geometry.height).toBeGreaterThan(450);
}

for (const theme of ['light', 'dark']) {
  test(`six real Code runs — ${theme}`, async () => {
    test.setTimeout(90_000);
    const booted = await bootApp({
      prepare: seedRuns,
      globalConfig: {
        theme,
        layout: { working: 'code', projects: true, terminal: false, projectsSplit: 0.3 },
        cardMinWidth: { code: 320 },
        terminal: { shell: '/bin/bash', memory: { enabled: false, appScope: { enabled: false } } },
      },
    });
    const { window: page } = booted;
    try {
      await page.setViewportSize({ width: 1100, height: 720 });
      await expect(page.locator('.repo-row')).toHaveCount(6);
      await page.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
      const codeTab = page.getByRole('tab', { name: 'Code', exact: true });
      const runsTab = page.getByRole('tab', { name: /^Active runs / });
      if (phase !== 'before') {
        await expect(codeTab).toHaveAttribute('aria-selected', 'true');
        await expect(runsTab).toHaveText('Active runs 0');
        await runsTab.click();
        await expect(page.getByRole('tabpanel', { name: 'Active runs 0' })).toContainText(
          'No active runs.',
        );
        await expectFullPanel(page, '#code-panel-runs');
        await capture(page, theme, 'zero');
        await codeTab.click();
      }
      // Reverse spawn order makes the existing repository-mirrored order observable.
      for (const name of [...repoNames].reverse()) {
        await page
          .locator('.repo-row')
          .filter({ hasText: `#${name}` })
          .getByRole('button', { name: 'Run', exact: true })
          .click();
        if (phase !== 'before') await expect(codeTab).toHaveAttribute('aria-selected', 'true');
      }
      await expect(page.locator('.code-run-row')).toHaveCount(6);
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const sessions = (await window.condash.termList()).filter(
              (session) => session.side === 'code',
            );
            const outputs = await Promise.all(
              sessions.map((session) => window.condash.termAttach(session.id)),
            );
            return outputs.filter((output) => output?.output.includes('READY:')).length;
          }),
        )
        .toBe(6);
      if (phase === 'before') {
        await capture(page, theme, 'code');
        await page.locator('.code-run-head').first().click();
        await expect(page.locator('.code-run-row.expanded .xterm')).toBeVisible();
        await capture(page, theme, 'expanded');
        return;
      }
      await expect(runsTab).toHaveText('Active runs 6');
      await expect(page.getByRole('tablist', { name: 'Code view' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Pull all', exact: true })).toBeVisible();
      await expect(page.locator('.branch-filter-trigger')).toBeVisible();
      await expectFullPanel(page, '#code-panel-code');
      expect(await page.evaluate(() => window.__condashXterms?.size ?? 0)).toBe(0);
      await capture(page, theme, 'code');

      // Native tabs: one tab stop, automatic arrow/Home/End selection, valid associations.
      for (const tab of [codeTab, runsTab]) {
        const panelId = await tab.getAttribute('aria-controls');
        const tabId = await tab.getAttribute('id');
        await expect(page.locator(`#${panelId}`)).toHaveAttribute('aria-labelledby', tabId!);
      }
      await codeTab.focus();
      await page.keyboard.press('ArrowRight');
      await expect(runsTab).toBeFocused();
      await expect(runsTab).toHaveAttribute('aria-selected', 'true');
      await expect(runsTab).toHaveAttribute('tabindex', '0');
      await expect(codeTab).toHaveAttribute('tabindex', '-1');
      await expect(page.getByRole('button', { name: 'Pull all', exact: true })).toBeHidden();
      await expect(page.locator('.branch-filter-trigger')).toBeHidden();
      await expectFullPanel(page, '#code-panel-runs');
      await expect(page.locator('.code-run-row .repo')).toHaveText(
        repoNames.map((name) => `#${name}`),
      );
      await capture(page, theme, 'runs');
      await page.keyboard.press('ArrowRight');
      await expect(codeTab).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(runsTab).toBeFocused();
      await page.keyboard.press('Home');
      await expect(codeTab).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('End');
      await expect(runsTab).toHaveAttribute('aria-selected', 'true');

      // Observe real resize calls without replacing their implementation or any row.
      await booted.app.evaluate(({ ipcMain }) => {
        const handlers = (
          ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> }
        )._invokeHandlers;
        const original = handlers.get('termResize')!;
        (globalThis as any).__codeRunResizes = [];
        ipcMain.removeHandler('termResize');
        ipcMain.handle('termResize', (event, ...args) => {
          (globalThis as any).__codeRunResizes.push(args);
          return original(event, ...args);
        });
      });
      const sessions = await page.evaluate(() => window.condash.termList());
      const first = sessions.find((session) => session.repo === repoNames[0])!;
      await page.locator('.code-run-head').first().click();
      await expect(page.locator('.code-run-row.expanded .xterm')).toBeVisible();
      await expect.poll(() => terminalText(page, first.id)).toContain('READY:cedar');
      await expect
        .poll(() => page.evaluate((id) => window.condash.termGeometry(id), first.id))
        .toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.condash.termGeometry(id), first.id))!.rows,
        )
        .toBeGreaterThan(2);
      await expect
        .poll(() => booted.app.evaluate(() => (globalThis as any).__codeRunResizes.length))
        .toBeGreaterThan(0);
      await capture(page, theme, 'expanded');
      const visibleGeometry = await page.evaluate(
        (id) => window.condash.termGeometry(id),
        first.id,
      );
      const identity = await page.evaluateHandle(
        (id) => ({
          row: document.querySelector('.code-run-row'),
          host: document.querySelector('.code-run-row .xterm'),
          term: window.__condashXterms?.get(id),
        }),
        first.id,
      );
      const beforeHidden = await terminalText(page, first.id);
      const nextTick =
        Math.max(
          ...[...beforeHidden.matchAll(/cedar tick:(\d+)/g)].map((match) => Number(match[1])),
        ) + 3;
      const beforeResizes = await booted.app.evaluate(
        () => (globalThis as any).__codeRunResizes.length,
      );
      await codeTab.click();
      await expect(page.locator('.code-run-row.expanded')).toBeHidden();
      await page.setViewportSize({ width: 1000, height: 720 });
      await expect.poll(() => terminalText(page, first.id)).toContain(`cedar tick:${nextTick}`);
      expect(await booted.app.evaluate(() => (globalThis as any).__codeRunResizes.length)).toBe(
        beforeResizes,
      );
      await runsTab.click();
      await expect(page.locator('.code-run-row.expanded .xterm')).toBeVisible();
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.condash.termGeometry(id), first.id))!.cols,
        )
        .toBeLessThan(visibleGeometry!.cols);
      expect(
        await page.evaluate(
          ({ identity, id }) =>
            identity.row === document.querySelector('.code-run-row') &&
            identity.host === document.querySelector('.code-run-row .xterm') &&
            identity.term === window.__condashXterms?.get(id),
          { identity, id: first.id },
        ),
      ).toBe(true);
      await expect.poll(() => terminalText(page, first.id)).toContain(`cedar tick:${nextTick}`);
      await page.locator('.code-run-head').first().click();
      await expect(page.locator('.code-run-row.expanded')).toHaveCount(0);
      await page.locator('.code-run-head').first().click();
      await expect(page.locator('.code-run-row.expanded .xterm')).toBeVisible();
      expect(
        await page.evaluate(
          ({ identity, id }) => identity.term === window.__condashXterms?.get(id),
          { identity, id: first.id },
        ),
      ).toBe(true);
      await identity.dispose();
      const resizes = await booted.app.evaluate(
        () => (globalThis as any).__codeRunResizes as [string, number, number][],
      );
      expect(resizes.length).toBeGreaterThan(0);
      expect(resizes.every(([, cols, rows]) => cols > 2 && rows > 1)).toBe(true);
      await page.setViewportSize({ width: 1100, height: 720 });

      // Natural exit retains the row/output; Stop closes a real process and its row.
      await page.evaluate((id) => window.condash.termWrite(id, 'exit\r'), first.id);
      await expect(page.locator('.code-run-row').first()).toContainText('exited 7');
      await expect.poll(() => terminalText(page, first.id)).toContain('[process exited 7]');
      await page
        .locator('.code-run-row')
        .first()
        .getByRole('button', { name: 'Stop', exact: true })
        .click();
      await expect(runsTab).toHaveText('Active runs 5');
      const next = sessions.find((session) => session.repo === repoNames[1])!;
      const attached = await page.evaluate((id) => window.condash.termAttach(id), next.id);
      const pid = Number(attached!.output.match(/PID:(\d+)/)![1]);
      await page
        .locator('.code-run-row')
        .first()
        .getByRole('button', { name: 'Stop', exact: true })
        .click();
      await expect(runsTab).toHaveText('Active runs 4');
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);

      // The root owns selection, not the CodeView instance destroyed by these rail actions.
      const rail = page.getByRole('complementary', { name: 'Activity rail' });
      await rail.getByRole('button', { name: 'Code (Ctrl+Shift+C)', exact: true }).click();
      await expect(page.locator('.repos-pane')).toHaveCount(0);
      await rail.getByRole('button', { name: 'Code (Ctrl+Shift+C)', exact: true }).click();
      await expect(runsTab).toHaveAttribute('aria-selected', 'true');
      await rail.getByRole('button', { name: 'Knowledge', exact: true }).click();
      await expect(page.locator('.repos-pane')).toHaveCount(0);
      await rail.getByRole('button', { name: 'Code (Ctrl+Shift+C)', exact: true }).click();
      await expect(runsTab).toHaveAttribute('aria-selected', 'true');
      await page.reload();
      await expect(codeTab).toHaveAttribute('aria-selected', 'true');
      await expect(runsTab).toHaveText('Active runs 4');

      await runsTab.click();
      const secondRoot = join(booted.conceptionDir, 'second-conception');
      await mkdir(join(secondRoot, '.condash'), { recursive: true });
      await mkdir(join(secondRoot, 'knowledge'), { recursive: true });
      const secondProject = join(secondRoot, 'projects', '2026-10', '2026-10-30-second');
      await mkdir(secondProject, { recursive: true });
      await writeFile(
        join(secondProject, 'README.md'),
        '# Second project\n\n**Status**: now\n**Kind**: project\n',
      );
      await writeFile(
        join(secondRoot, '.condash', 'settings.json'),
        JSON.stringify({
          workspace_path: join(booted.conceptionDir, 'workspace'),
          repositories: repoNames.map((name) => ({ name, run: '/bin/bash ./run.sh' })),
        }),
      );
      await booted.app.evaluate(
        ({ BrowserWindow }, path) =>
          BrowserWindow.getAllWindows()[0]!.webContents.send('menu-open-recent', path),
        secondRoot,
      );
      await expect(page.locator('.status-bar-path')).toHaveText(secondRoot);
      await expect(codeTab).toHaveAttribute('aria-selected', 'true');
      // Stop remaining sessions through the visible run rows; count and panels remain valid at zero.
      await runsTab.click();
      while (await page.locator('.code-run-row').count()) {
        const count = await page.locator('.code-run-row').count();
        await page
          .locator('.code-run-row')
          .first()
          .getByRole('button', { name: 'Stop', exact: true })
          .click();
        await expect(page.locator('.code-run-row')).toHaveCount(count - 1);
      }
      await expect(runsTab).toHaveText('Active runs 0');
      await expect(page.getByRole('tabpanel', { name: 'Active runs 0' })).toContainText(
        'No active runs.',
      );
      await expectFullPanel(page, '#code-panel-runs');
    } finally {
      await booted.cleanup();
    }
  });
}
