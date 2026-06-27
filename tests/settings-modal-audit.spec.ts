import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { bootApp, type BootedApp } from './fixtures/electron-app';

/**
 * Representative audit of the scope-partitioned Settings modal (project
 * 2026-06-27-settings-scope-revamp). The old two-tab + inheritance-badge UI is
 * gone: every setting has exactly one home file, every section renders once on
 * a single scrolling surface with a flat id (`settings-section-<id>`), and the
 * file a section writes is named by its scope chip.
 *
 * This spec keeps one representative field per file/section, drives the UI to
 * set a known value, and polls the matching on-disk file until the value lands.
 * It records every field's outcome (ok / absent / mismatch / error) into a JSON
 * findings file, and makes hard assertions on the round-trips that prove the
 * scope partition (theme → settings.json, workspace_path → .condash/settings.json).
 */

/**
 * Findings output file. Defaults to `test-results/settings-modal-audit-findings.json`
 * under the repo root — CI-safe. A driving project can override to its own
 * `local/` path via the `CONDASH_AUDIT_FINDINGS_OUT` env var.
 */
const FINDINGS_OUT =
  process.env.CONDASH_AUDIT_FINDINGS_OUT ??
  resolve(__dirname, '..', 'test-results', 'settings-modal-audit-findings.json');

/** Every section now renders once, with a flat id and a single scope. */
const SECTIONS: { id: string; scope: 'global' | 'conception' }[] = [
  { id: 'recents', scope: 'global' },
  { id: 'appearance', scope: 'global' },
  { id: 'terminal', scope: 'global' },
  { id: 'agents', scope: 'global' },
  { id: 'open-with', scope: 'global' },
  { id: 'dashboard', scope: 'global' },
  { id: 'workspace', scope: 'conception' },
  { id: 'repositories', scope: 'conception' },
];

interface Finding {
  scope: 'global' | 'conception';
  section: string;
  field: string;
  expectedKey: string;
  expectedValue: unknown;
  observed: unknown;
  status: 'ok' | 'mismatch' | 'absent' | 'error';
  detail?: string;
}

const findings: Finding[] = [];

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/** Walk dotted path through an object. Returns `undefined` if any segment missing. */
function dig(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Poll the file until `predicate` is true or timeout. The modal defers writes
 *  behind Save, so a single IPC round-trip happens after each `commitSave`. */
async function waitForFile(
  path: string,
  predicate: (parsed: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  let parsed: Record<string, unknown> = await readJson(path);
  while (!predicate(parsed)) {
    if (Date.now() - start > timeoutMs) return parsed;
    await new Promise((r) => setTimeout(r, 40));
    parsed = await readJson(path);
  }
  return parsed;
}

async function persistFindings(): Promise<void> {
  await mkdir(dirname(FINDINGS_OUT), { recursive: true });
  await writeFile(FINDINGS_OUT, JSON.stringify({ findings }, null, 2) + '\n', 'utf8');
}

const SCROLL_TIMEOUT_MS = 2500;

async function safeScroll(loc: Locator): Promise<void> {
  await loc.scrollIntoViewIfNeeded({ timeout: SCROLL_TIMEOUT_MS }).catch(() => undefined);
}

/**
 * Flush staged edits to disk. The modal defers every write behind the Save
 * button — edits only mutate an in-memory draft until Save fires. No-op when
 * the modal isn't dirty (Save disabled), so a field that didn't change state
 * records its finding without a stray click.
 */
async function commitSave(page: Page): Promise<void> {
  const saveBtn = page.locator('.settings-modal button.settings-save');
  if (await saveBtn.isEnabled().catch(() => false)) {
    await saveBtn.click({ timeout: 3000 }).catch(() => undefined);
  }
}

/** Expand a collapsible terminal subgroup so its fields become interactable.
 *  "Behaviour & shortcuts" ships open; Font / Cursor & buffer / Colours /
 *  Logging start collapsed. */
async function expandSubgroup(modal: Locator, title: string): Promise<void> {
  const summary = modal.locator('summary.settings-subgroup-summary', { hasText: title }).first();
  if ((await summary.count()) === 0) return;
  const isOpen = await summary
    .evaluate((el) => (el.parentElement as HTMLDetailsElement).open)
    .catch(() => true);
  if (!isOpen) await summary.click().catch(() => undefined);
}

async function auditText(opts: {
  scope: 'global' | 'conception';
  section: string;
  field: string;
  expectedKey: string;
  filePath: string;
  input: Locator;
  value: string;
}): Promise<void> {
  try {
    await safeScroll(opts.input);
    await opts.input.fill(opts.value, { timeout: 3000 });
    await opts.input.blur({ timeout: 1500 }).catch(() => undefined);
    await commitSave(opts.input.page());
    const parsed = await waitForFile(opts.filePath, (p) => dig(p, opts.expectedKey) === opts.value);
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      ...metaOf(opts),
      observed,
      status: observed === opts.value ? 'ok' : observed === undefined ? 'absent' : 'mismatch',
    });
  } catch (err) {
    findings.push({ ...metaOf(opts), observed: undefined, status: 'error', detail: msg(err) });
  }
}

async function auditNumber(opts: {
  scope: 'global' | 'conception';
  section: string;
  field: string;
  expectedKey: string;
  filePath: string;
  input: Locator;
  value: number;
}): Promise<void> {
  try {
    await safeScroll(opts.input);
    await opts.input.fill(String(opts.value), { timeout: 3000 });
    await opts.input.blur({ timeout: 1500 }).catch(() => undefined);
    await commitSave(opts.input.page());
    const parsed = await waitForFile(opts.filePath, (p) => dig(p, opts.expectedKey) === opts.value);
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      ...metaOf(opts),
      observed,
      status: observed === opts.value ? 'ok' : observed === undefined ? 'absent' : 'mismatch',
    });
  } catch (err) {
    findings.push({ ...metaOf(opts), observed: undefined, status: 'error', detail: msg(err) });
  }
}

async function auditSelect(opts: {
  scope: 'global' | 'conception';
  section: string;
  field: string;
  expectedKey: string;
  filePath: string;
  select: Locator;
  value: string;
}): Promise<void> {
  try {
    await safeScroll(opts.select);
    await opts.select.selectOption(opts.value, { timeout: 3000 });
    await commitSave(opts.select.page());
    const parsed = await waitForFile(opts.filePath, (p) => dig(p, opts.expectedKey) === opts.value);
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      ...metaOf({ ...opts, expectedValue: opts.value }),
      observed,
      status: observed === opts.value ? 'ok' : observed === undefined ? 'absent' : 'mismatch',
    });
  } catch (err) {
    findings.push({
      ...metaOf({ ...opts, expectedValue: opts.value }),
      observed: undefined,
      status: 'error',
      detail: msg(err),
    });
  }
}

async function auditCheckbox(opts: {
  scope: 'global' | 'conception';
  section: string;
  field: string;
  expectedKey: string;
  filePath: string;
  checkbox: Locator;
  value: boolean;
}): Promise<void> {
  try {
    await safeScroll(opts.checkbox);
    if (opts.value) {
      await opts.checkbox.check({ timeout: 3000 });
    } else {
      await opts.checkbox.uncheck({ timeout: 3000 });
    }
    await commitSave(opts.checkbox.page());
    const parsed = await waitForFile(opts.filePath, (p) => dig(p, opts.expectedKey) === opts.value);
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      ...metaOf({ ...opts, expectedValue: opts.value }),
      observed,
      // For some keys the false-state is "key absent" by design (pruneEmpty).
      status:
        observed === opts.value
          ? 'ok'
          : observed === undefined && opts.value === false
            ? 'ok'
            : observed === undefined
              ? 'absent'
              : 'mismatch',
    });
  } catch (err) {
    findings.push({
      ...metaOf({ ...opts, expectedValue: opts.value }),
      observed: undefined,
      status: 'error',
      detail: msg(err),
    });
  }
}

/** Build the common finding fields from an audit options bag. */
function metaOf(opts: {
  scope: 'global' | 'conception';
  section: string;
  field: string;
  expectedKey: string;
  value?: unknown;
  expectedValue?: unknown;
}): Omit<Finding, 'observed' | 'status'> {
  return {
    scope: opts.scope,
    section: opts.section,
    field: opts.field,
    expectedKey: opts.expectedKey,
    expectedValue: opts.expectedValue ?? opts.value,
  };
}

function msg(err: unknown): string {
  return (err as Error).message;
}

async function openSettings(window: Page, app: BootedApp['app']): Promise<Locator> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('menu-command', 'open-settings');
  });
  const modal = window.locator('.settings-modal');
  await modal.waitFor({ state: 'visible' });
  return modal;
}

test('settings modal: representative fields render and round-trip to the right file', async () => {
  test.setTimeout(240_000);
  const booted = await bootApp({ extraConfig: {} });
  // settings.json is isolated under <userDataDir>/condash/ (XDG_CONFIG_HOME →
  // app.getPath('userData')); the conception file is <conceptionDir>/.condash/.
  const settingsPath = join(booted.userDataDir, 'condash', 'settings.json');
  const conceptionPath = join(booted.conceptionDir, '.condash', 'settings.json');
  // Flush findings periodically so a timeout still produces output.
  const flushTimer = setInterval(() => void persistFindings().catch(() => undefined), 2000);
  try {
    const modal = await openSettings(booted.window, booted.app);

    // ---- Every section renders once on the single surface (flat ids) ------
    for (const s of SECTIONS) {
      await expect(modal.locator(`section#settings-section-${s.id}`)).toHaveCount(1);
      await expect(
        modal.locator(`#settings-section-${s.id} .settings-scope-chip--${s.scope}`),
      ).toBeVisible();
    }

    // ======================= GLOBAL — settings.json =======================

    // Appearance · Theme radio (global-only; no per-conception override).
    {
      const darkRadio = modal
        .locator('#settings-section-appearance .settings-radio', { hasText: 'Dark' })
        .locator('input[type="radio"]');
      await safeScroll(darkRadio);
      await darkRadio.check({ timeout: 3000 });
      await commitSave(booted.window);
      const parsed = await waitForFile(settingsPath, (p) => p.theme === 'dark');
      findings.push({
        scope: 'global',
        section: 'Appearance',
        field: 'Theme = dark',
        expectedKey: 'theme',
        expectedValue: 'dark',
        observed: parsed.theme,
        status: parsed.theme === 'dark' ? 'ok' : 'mismatch',
      });
    }

    // Appearance · card density (representative panes — an original and a
    // late-added one, the pair that previously shipped unsavable).
    {
      const density: { label: string; key: string; value: number }[] = [
        { label: 'Project cards', key: 'cardMinWidth.projects', value: 360 },
        { label: 'Log cards', key: 'cardMinWidth.logs', value: 480 },
      ];
      for (const d of density) {
        const input = modal
          .locator('#settings-section-appearance label', { hasText: d.label })
          .first()
          .locator('input[type="number"]')
          .first();
        await auditNumber({
          scope: 'global',
          section: 'Appearance',
          field: `Card density: ${d.label}`,
          expectedKey: d.key,
          filePath: settingsPath,
          input,
          value: d.value,
        });
      }
    }

    // Terminal · Behaviour & shortcuts (ships open). The two path/text fields
    // round-trip; the four shortcut fields render as capture buttons.
    {
      const textFields: { field: string; key: string }[] = [
        { field: 'Shell', key: 'shell' },
        { field: 'Screenshot directory', key: 'screenshot_dir' },
      ];
      for (const sf of textFields) {
        const input = modal
          .locator('#settings-section-terminal label', { hasText: sf.field })
          .first()
          .locator('input[type="text"]')
          .first();
        await auditText({
          scope: 'global',
          section: 'Terminal',
          field: sf.field,
          expectedKey: `terminal.${sf.key}`,
          filePath: settingsPath,
          input,
          value: `audit-${sf.key}`,
        });
      }
      await expect(
        modal.locator('#settings-section-terminal .settings-shortcut').first(),
      ).toBeVisible();
    }

    // Terminal · Font (collapsed — expand first).
    await expandSubgroup(modal, 'Font');
    {
      const familyInput = modal
        .locator('#settings-section-terminal label', { hasText: 'Font family' })
        .first()
        .locator('input[type="text"]')
        .first();
      await auditText({
        scope: 'global',
        section: 'Terminal · Font',
        field: 'Font family',
        expectedKey: 'terminal.xterm.font_family',
        filePath: settingsPath,
        input: familyInput,
        value: 'Audit Mono, monospace',
      });
      const sizeInput = modal
        .locator('#settings-section-terminal label', { hasText: 'Font size' })
        .first()
        .locator('input[type="number"]')
        .first();
      await auditNumber({
        scope: 'global',
        section: 'Terminal · Font',
        field: 'Font size',
        expectedKey: 'terminal.xterm.font_size',
        filePath: settingsPath,
        input: sizeInput,
        value: 14,
      });
    }

    // Terminal · Cursor & buffer (collapsed — expand first).
    await expandSubgroup(modal, 'Cursor & buffer');
    {
      const cursorSelect = modal
        .locator('#settings-section-terminal label', { hasText: 'Cursor style' })
        .first()
        .locator('select');
      await auditSelect({
        scope: 'global',
        section: 'Terminal · Cursor',
        field: 'Cursor style',
        expectedKey: 'terminal.xterm.cursor_style',
        filePath: settingsPath,
        select: cursorSelect,
        value: 'underline',
      });
      const blink = modal
        .locator('#settings-section-terminal label.settings-checkbox', { hasText: 'Cursor blink' })
        .first()
        .locator('input[type="checkbox"]');
      await auditCheckbox({
        scope: 'global',
        section: 'Terminal · Cursor',
        field: 'Cursor blink (uncheck)',
        expectedKey: 'terminal.xterm.cursor_blink',
        filePath: settingsPath,
        checkbox: blink,
        value: false,
      });
    }

    // Terminal · Colours (collapsed — expand first; representative entries).
    await expandSubgroup(modal, 'Colours');
    {
      const colours: { label: string; key: string; value: string }[] = [
        { label: 'Foreground', key: 'foreground', value: '#abcdef' },
        { label: 'Background', key: 'background', value: '#102030' },
      ];
      for (const c of colours) {
        const input = modal
          .locator('#settings-section-terminal label.settings-color', { hasText: c.label })
          .first()
          .locator('input[type="text"]')
          .first();
        await auditText({
          scope: 'global',
          section: 'Terminal · Colours',
          field: c.label,
          expectedKey: `terminal.xterm.colors.${c.key}`,
          filePath: settingsPath,
          input,
          value: c.value,
        });
      }
    }

    // Terminal · Logging (collapsed — expand first).
    await expandSubgroup(modal, 'Logging');
    {
      const enabled = modal
        .locator('#settings-section-terminal label.settings-checkbox', {
          hasText: 'Record terminal sessions to disk',
        })
        .first()
        .locator('input[type="checkbox"]');
      await auditCheckbox({
        scope: 'global',
        section: 'Terminal · Logging',
        field: 'Record sessions (check)',
        expectedKey: 'terminal.logging.enabled',
        filePath: settingsPath,
        checkbox: enabled,
        value: true,
      });
      const retention = modal
        .locator('#settings-section-terminal label', { hasText: 'Retention (days)' })
        .first()
        .locator('input[type="number"]')
        .first();
      await auditNumber({
        scope: 'global',
        section: 'Terminal · Logging',
        field: 'Retention (days)',
        expectedKey: 'terminal.logging.retentionDays',
        filePath: settingsPath,
        input: retention,
        value: 30,
      });
    }

    // Open with — now a personal (global) setting. One slot, command then
    // label (the modal drops the slot when its command is empty).
    {
      const block = modal.locator('#settings-section-open-with .settings-open-with').first();
      await auditText({
        scope: 'global',
        section: 'Open with',
        field: 'main_ide · command',
        expectedKey: 'open_with.main_ide.command',
        filePath: settingsPath,
        input: block.locator('input[type="text"]').nth(1),
        value: 'audit-main {path}',
      });
      await auditText({
        scope: 'global',
        section: 'Open with',
        field: 'main_ide · label',
        expectedKey: 'open_with.main_ide.label',
        filePath: settingsPath,
        input: block.locator('input[type="text"]').nth(0),
        value: 'Audit IDE',
      });
    }

    // =================== CONCEPTION — .condash/settings.json ===================

    // Workspace block — two path fields.
    {
      const workspace = modal.locator('#settings-section-workspace');
      await safeScroll(workspace);
      const fields: { label: string; key: string; value: string }[] = [
        { label: 'Workspace path', key: 'workspace_path', value: '/tmp/audit-workspace' },
        { label: 'Worktrees path', key: 'worktrees_path', value: '/tmp/audit-worktrees' },
      ];
      for (const wf of fields) {
        const input = workspace
          .locator('.settings-field-with-badge', { hasText: wf.label })
          .first()
          .locator('input[type="text"]')
          .first();
        await auditText({
          scope: 'conception',
          section: 'Workspace',
          field: wf.label,
          expectedKey: wf.key,
          filePath: conceptionPath,
          input,
          value: wf.value,
        });
      }
    }

    // Repositories — add a row and fill its name (compacts to a bare string).
    {
      const reposSection = modal.locator('#settings-section-repositories');
      await safeScroll(reposSection);
      await reposSection.locator('button.modal-button', { hasText: '+ Add repo' }).click();
      await booted.window.waitForTimeout(150);
      const nameInput = reposSection.locator('.settings-repo-row input.settings-repo-name').first();
      await auditText({
        scope: 'conception',
        section: 'Repositories',
        field: 'First row · name',
        expectedKey: 'repositories.0',
        filePath: conceptionPath,
        input: nameInput,
        value: 'audit-repo-name',
      });
    }

    await persistFindings();

    // ---- Hard round-trips proving the scope partition --------------------
    // Theme is global; workspace path is conception. Neither bleeds into the
    // other file.
    expect((await readJson(settingsPath)).theme).toBe('dark');
    expect((await readJson(settingsPath)).workspace_path).toBeUndefined();
    expect(await dig(await readJson(conceptionPath), 'workspace_path')).toBe(
      '/tmp/audit-workspace',
    );
    expect((await readJson(conceptionPath)).theme).toBeUndefined();
  } finally {
    clearInterval(flushTimer);
    await persistFindings().catch(() => undefined);
    await booted.cleanup();
  }
});
