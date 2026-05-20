import { test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { bootApp, type BootedApp } from './fixtures/electron-app';

/**
 * Comprehensive audit of every editable field in the revamped Settings
 * modal (PR #70). For each field this spec:
 *
 *  - Drives the UI to set a known value.
 *  - Polls the matching on-disk file (settings.json / condash.json) until
 *    the value lands at the schema key listed in `notes/01-inventory.md`.
 *  - Records the outcome (ok / missing / wrong-shape / never-written /
 *    fired-once-then-cleared) into a JSON file the project notes can read.
 *
 * Not a pass/fail test in the usual sense — the goal is to *describe* what
 * the current build does, so we know what to fix.
 */

/**
 * Findings output file. Defaults to `test-results/settings-modal-audit-findings.json`
 * under the repo root — CI-safe. A driving project (e.g. the conception note)
 * can override to its own `local/` path via the `CONDASH_AUDIT_FINDINGS_OUT`
 * env var.
 */
const FINDINGS_OUT =
  process.env.CONDASH_AUDIT_FINDINGS_OUT ??
  resolve(__dirname, '..', 'test-results', 'settings-modal-audit-findings.json');

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
const fileSnapshots: { at: string; settings: unknown; condash: unknown }[] = [];

async function snapshot(label: string, settingsPath: string, conceptionPath: string): Promise<void> {
  const settings = await readJson(settingsPath);
  const condash = await readJson(conceptionPath);
  fileSnapshots.push({ at: label, settings, condash });
}

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

/** Poll the file until `predicate` is true or timeout. The revamped modal
 *  defers writes behind Save, so a single IPC round-trip happens after each
 *  `commitSave`; 2 s of headroom covers that on a slow CI runner while still
 *  bounding total runtime for the fields that genuinely never land. */
async function waitForFile(
  path: string,
  predicate: (parsed: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
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
  await writeFile(
    FINDINGS_OUT,
    JSON.stringify({ findings, fileSnapshots }, null, 2) + '\n',
    'utf8',
  );
}

/** Set a text input by Playwright locator, blur, wait, then record finding. */
const SCROLL_TIMEOUT_MS = 2500;

async function safeScroll(loc: Locator): Promise<void> {
  await loc.scrollIntoViewIfNeeded({ timeout: SCROLL_TIMEOUT_MS }).catch(() => undefined);
}

/**
 * Flush staged edits to disk. The revamped modal (v3.18.0) defers every
 * write behind the Save button — edits only mutate an in-memory draft until
 * Save fires. Each audit field stages, then calls this, then polls the file.
 * No-op when the modal isn't dirty (Save is disabled), so a field that didn't
 * actually change state records its finding without a stray click.
 */
async function commitSave(page: Page): Promise<void> {
  const saveBtn = page.locator('.settings-modal button.settings-save');
  if (await saveBtn.isEnabled().catch(() => false)) {
    await saveBtn.click({ timeout: 3000 }).catch(() => undefined);
  }
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
    const parsed = await waitForFile(
      opts.filePath,
      (p) => dig(p, opts.expectedKey) === opts.value,
    );
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed,
      status: observed === opts.value ? 'ok' : observed === undefined ? 'absent' : 'mismatch',
    });
  } catch (err) {
    findings.push({
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed: undefined,
      status: 'error',
      detail: (err as Error).message,
    });
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
    const parsed = await waitForFile(
      opts.filePath,
      (p) => dig(p, opts.expectedKey) === opts.value,
    );
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed,
      status: observed === opts.value ? 'ok' : observed === undefined ? 'absent' : 'mismatch',
    });
  } catch (err) {
    findings.push({
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed: undefined,
      status: 'error',
      detail: (err as Error).message,
    });
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
    const parsed = await waitForFile(
      opts.filePath,
      (p) => dig(p, opts.expectedKey) === opts.value,
    );
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed,
      status: observed === opts.value ? 'ok' : observed === undefined ? 'absent' : 'mismatch',
    });
  } catch (err) {
    findings.push({
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed: undefined,
      status: 'error',
      detail: (err as Error).message,
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
    const parsed = await waitForFile(
      opts.filePath,
      (p) => dig(p, opts.expectedKey) === opts.value,
    );
    const observed = dig(parsed, opts.expectedKey);
    findings.push({
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed,
      // For some keys, the false-state is "key absent" by design (pruneEmpty).
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
      scope: opts.scope,
      section: opts.section,
      field: opts.field,
      expectedKey: opts.expectedKey,
      expectedValue: opts.value,
      observed: undefined,
      status: 'error',
      detail: (err as Error).message,
    });
  }
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

test('settings modal: audit every field round-trips edit → on-disk', async () => {
  // ~70 fields, each staged then flushed via Save (one IPC write apiece). Runs
  // ~2.5 min locally; give generous margin for a slower CI runner so a single
  // pass never brushes the timeout (retries would otherwise stack 3×).
  test.setTimeout(480_000);
  const booted = await bootApp({ extraConfig: {} });
  const settingsPath = join(booted.userDataDir, 'condash', 'settings.json');
  const conceptionPath = join(booted.conceptionDir, '.condash', 'settings.json');
  // Flush findings every few seconds so a timeout still produces output.
  const flushTimer = setInterval(() => {
    void persistFindings().catch(() => undefined);
  }, 2000);
  try {
    const modal = await openSettings(booted.window, booted.app);

    await snapshot('start', settingsPath, conceptionPath);
    // ---- GLOBAL TAB ----------------------------------------------------
    const globalPanel = modal.locator('#settings-panel-global');
    await modal.locator('[role="tab"]').nth(0).click();

    // Theme radios (Global).
    {
      const darkRadio = globalPanel
        .locator('section#settings-section-appearance\\:global .settings-radio', { hasText: 'Dark' })
        .first()
        .locator('input[type="radio"]');
      try {
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
      } catch (err) {
        findings.push({
          scope: 'global',
          section: 'Appearance',
          field: 'Theme = dark',
          expectedKey: 'theme',
          expectedValue: 'dark',
          observed: undefined,
          status: 'error',
          detail: (err as Error).message,
        });
      }
    }

    // Card density (5 panes)
    const densityKeys: ('projects' | 'code' | 'knowledge' | 'resources' | 'skills')[] = [
      'projects',
      'code',
      'knowledge',
      'resources',
      'skills',
    ];
    const densityValues = [222, 333, 444, 555, 666];
    for (let i = 0; i < densityKeys.length; i++) {
      const label = densityKeys[i];
      const value = densityValues[i];
      const labelRow = globalPanel
        .locator('section#settings-section-appearance\\:global label', {
          hasText: `${labelText(label)}`,
        })
        .first();
      const input = labelRow.locator('input[type="number"]').first();
      await auditNumber({
        scope: 'global',
        section: 'Appearance',
        field: `Card density: ${label}`,
        expectedKey: `cardMinWidth.${label}`,
        filePath: settingsPath,
        input,
        value,
      });
    }

    // Terminal — string fields.
    const stringFields: { field: string; key: string }[] = [
      { field: 'Shell', key: 'shell' },
      { field: 'Launcher command', key: 'launcher_command' },
      { field: 'Screenshot directory', key: 'screenshot_dir' },
      { field: 'Toggle terminal pane', key: 'shortcut' },
      { field: 'Paste latest screenshot path', key: 'screenshot_paste_shortcut' },
      { field: 'Move tab left', key: 'move_tab_left_shortcut' },
      { field: 'Move tab right', key: 'move_tab_right_shortcut' },
    ];
    for (const sf of stringFields) {
      const row = globalPanel
        .locator('section#settings-section-terminal\\:global label', { hasText: sf.field })
        .first();
      const input = row.locator('input[type="text"]').first();
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

    // Terminal — font block.
    const fontText: { label: string; key: string; value: string }[] = [
      { label: 'Font family', key: 'terminal.xterm.font_family', value: 'Audit Mono, monospace' },
      { label: 'Font weight', key: 'terminal.xterm.font_weight', value: '500' },
      { label: 'Bold weight', key: 'terminal.xterm.font_weight_bold', value: '700' },
    ];
    for (const ft of fontText) {
      const row = globalPanel
        .locator('section#settings-section-terminal\\:global label', { hasText: ft.label })
        .first();
      const input = row.locator('input[type="text"]').first();
      await auditText({
        scope: 'global',
        section: 'Terminal · Font',
        field: ft.label,
        expectedKey: ft.key,
        filePath: settingsPath,
        input,
        value: ft.value,
      });
    }

    const fontNum: { label: string; key: string; value: number }[] = [
      { label: 'Font size', key: 'terminal.xterm.font_size', value: 14 },
      { label: 'Line height', key: 'terminal.xterm.line_height', value: 1.25 },
      { label: 'Letter spacing', key: 'terminal.xterm.letter_spacing', value: 1 },
      { label: 'Scrollback', key: 'terminal.xterm.scrollback', value: 7777 },
    ];
    for (const ft of fontNum) {
      const row = globalPanel
        .locator('section#settings-section-terminal\\:global label', { hasText: ft.label })
        .first();
      const input = row.locator('input[type="number"]').first();
      await auditNumber({
        scope: 'global',
        section: 'Terminal · Font/Buffer',
        field: ft.label,
        expectedKey: ft.key,
        filePath: settingsPath,
        input,
        value: ft.value,
      });
    }

    // Cursor style.
    const cursorSelect = globalPanel
      .locator('section#settings-section-terminal\\:global label', { hasText: 'Cursor style' })
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

    // Cursor blink (default state is checked — uncheck for the audit).
    const cursorBlinkRow = globalPanel
      .locator('section#settings-section-terminal\\:global label.settings-checkbox', {
        hasText: 'Cursor blink',
      })
      .first();
    await auditCheckbox({
      scope: 'global',
      section: 'Terminal · Cursor',
      field: 'Cursor blink (uncheck)',
      expectedKey: 'terminal.xterm.cursor_blink',
      filePath: settingsPath,
      checkbox: cursorBlinkRow.locator('input[type="checkbox"]'),
      value: false,
    });

    // Ligatures.
    const ligaturesRow = globalPanel
      .locator('section#settings-section-terminal\\:global label.settings-checkbox', {
        hasText: 'ligatures',
      })
      .first();
    await auditCheckbox({
      scope: 'global',
      section: 'Terminal · Cursor',
      field: 'Ligatures (check)',
      expectedKey: 'terminal.xterm.ligatures',
      filePath: settingsPath,
      checkbox: ligaturesRow.locator('input[type="checkbox"]'),
      value: true,
    });

    // Colours — 21 entries.
    const colorKeys = [
      'foreground',
      'background',
      'cursor',
      'cursor_accent',
      'selection_background',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'bright_black',
      'bright_red',
      'bright_green',
      'bright_yellow',
      'bright_blue',
      'bright_magenta',
      'bright_cyan',
      'bright_white',
    ];
    const colorLabels: Record<string, string> = {
      foreground: 'Foreground',
      background: 'Background',
      cursor: 'Cursor',
      cursor_accent: 'Cursor accent',
      selection_background: 'Selection bg',
      black: 'ANSI black',
      red: 'ANSI red',
      green: 'ANSI green',
      yellow: 'ANSI yellow',
      blue: 'ANSI blue',
      magenta: 'ANSI magenta',
      cyan: 'ANSI cyan',
      white: 'ANSI white',
      bright_black: 'Bright black',
      bright_red: 'Bright red',
      bright_green: 'Bright green',
      bright_yellow: 'Bright yellow',
      bright_blue: 'Bright blue',
      bright_magenta: 'Bright magenta',
      bright_cyan: 'Bright cyan',
      bright_white: 'Bright white',
    };
    for (let i = 0; i < colorKeys.length; i++) {
      const key = colorKeys[i];
      const value = `#${(0x100000 + i * 0x010101).toString(16).slice(-6)}`;
      const row = globalPanel
        .locator('section#settings-section-terminal\\:global label.settings-color', {
          hasText: colorLabels[key],
        })
        .first();
      const input = row.locator('input[type="text"]').first();
      await auditText({
        scope: 'global',
        section: 'Terminal · Colors',
        field: colorLabels[key],
        expectedKey: `terminal.xterm.colors.${key}`,
        filePath: settingsPath,
        input,
        value,
      });
    }

    await snapshot('after-global-pass', settingsPath, conceptionPath);
    // ---- CONCEPTION TAB -----------------------------------------------
    await modal.locator('[role="tab"]').nth(1).click({ timeout: 5000 }).catch(() => undefined);
    const conceptionPanel = modal.locator('#settings-panel-conception');

    // Workspace block — four path fields.
    const workspaceFields: { label: string; key: string; value: string }[] = [
      { label: 'Workspace path', key: 'workspace_path', value: '/tmp/audit-workspace' },
      { label: 'Worktrees path', key: 'worktrees_path', value: '/tmp/audit-worktrees' },
      { label: 'Resources directory', key: 'resources_path', value: 'custom/resources' },
      { label: 'Skills directory', key: 'skills_path', value: '.claude/skills-audit' },
    ];
    for (const wf of workspaceFields) {
      const row = conceptionPanel
        .locator('section#settings-section-workspace\\:conception .settings-field-with-badge', {
          hasText: wf.label,
        })
        .first();
      const input = row.locator('input[type="text"]').first();
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

    // Open with — 3 slots × {label, command}. Order is fixed.
    const openWithSlots: { key: string }[] = [
      { key: 'main_ide' },
      { key: 'secondary_ide' },
      { key: 'terminal' },
    ];
    for (let i = 0; i < openWithSlots.length; i++) {
      const slot = openWithSlots[i];
      const block = conceptionPanel
        .locator('section#settings-section-open-with\\:conception .settings-open-with')
        .nth(i);
      const labelInput = block.locator('input[type="text"]').nth(0);
      const commandInput = block.locator('input[type="text"]').nth(1);
      // Command must be set first — modal deletes the slot when command is empty.
      await auditText({
        scope: 'conception',
        section: 'Open with',
        field: `${slot.key} · command`,
        expectedKey: `open_with.${slot.key}.command`,
        filePath: conceptionPath,
        input: commandInput,
        value: `audit-${slot.key}-cmd {path}`,
      });
      await auditText({
        scope: 'conception',
        section: 'Open with',
        field: `${slot.key} · label`,
        expectedKey: `open_with.${slot.key}.label`,
        filePath: conceptionPath,
        input: labelInput,
        value: `audit-${slot.key}-label`,
      });
    }

    // Repositories — add one row, fill its name + label.
    const reposSection = conceptionPanel.locator('section#settings-section-repositories\\:conception');
    const addRepoBtn = reposSection.locator('button.modal-button', { hasText: '+ Add repo' });
    await addRepoBtn.click();
    await booted.window.waitForTimeout(150);
    // The added row's name input is the first text input under .settings-bucket.
    const repoRows = reposSection.locator('.settings-bucket > *');
    const firstRow = repoRows.first();
    // Try the most common shape — name input is labelled "Name" or first text input.
    const repoNameInput = firstRow.locator('input[type="text"]').first();
    await auditText({
      scope: 'conception',
      section: 'Repositories',
      field: 'First row · name',
      expectedKey: 'repositories.0',
      filePath: conceptionPath,
      input: repoNameInput,
      value: 'audit-repo-name',
    });

    // Conception · Theme override.
    {
      const darkRadio = conceptionPanel
        .locator('section#settings-section-appearance\\:conception .settings-radio', {
          hasText: 'Light',
        })
        .first()
        .locator('input[type="radio"]');
      try {
        await safeScroll(darkRadio);
        await darkRadio.check({ timeout: 3000 });
        await commitSave(booted.window);
        const parsed = await waitForFile(conceptionPath, (p) => p.theme === 'light');
        findings.push({
          scope: 'conception',
          section: 'Appearance',
          field: 'Theme override = light',
          expectedKey: 'theme',
          expectedValue: 'light',
          observed: parsed.theme,
          status: parsed.theme === 'light' ? 'ok' : 'mismatch',
        });
      } catch (err) {
        findings.push({
          scope: 'conception',
          section: 'Appearance',
          field: 'Theme override = light',
          expectedKey: 'theme',
          expectedValue: 'light',
          observed: undefined,
          status: 'error',
          detail: (err as Error).message,
        });
      }
    }

    // Conception · Card density override (one pane is enough).
    {
      const labelRow = conceptionPanel
        .locator('section#settings-section-appearance\\:conception label', {
          hasText: 'Project cards',
        })
        .first();
      const input = labelRow.locator('input[type="number"]').first();
      await auditNumber({
        scope: 'conception',
        section: 'Appearance',
        field: 'Card density override · projects',
        expectedKey: 'cardMinWidth.projects',
        filePath: conceptionPath,
        input,
        value: 999,
      });
    }

    // Conception · Terminal override (one shell field is enough — same
    // codepath as global terminal).
    {
      const row = conceptionPanel
        .locator('section#settings-section-terminal\\:conception label', { hasText: 'Shell' })
        .first();
      const input = row.locator('input[type="text"]').first();
      await auditText({
        scope: 'conception',
        section: 'Terminal',
        field: 'Shell (override)',
        expectedKey: 'terminal.shell',
        filePath: conceptionPath,
        input,
        value: '/usr/bin/audit-shell',
      });
    }

    // Conception · Repo row object-form fields (label, run, force_stop, install,
    // pinned_branch). Forces `compactRepos` to keep the object shape.
    {
      const reposSec = conceptionPanel.locator('section#settings-section-repositories\\:conception');
      const firstRow = reposSec.locator('.settings-bucket .settings-repo-row').first();
      const objectFields: { label: string; subKey: string; value: string }[] = [
        { label: 'Label', subKey: 'label', value: 'Audit Label' },
        { label: 'Run command', subKey: 'run', value: 'audit-run-cmd' },
        { label: 'Force stop', subKey: 'force_stop', value: 'audit-force-stop' },
        { label: 'Install command', subKey: 'install', value: 'audit-install' },
        // pinned_branch is in the schema but the modal does not surface it.
        // Captured as a separate finding below.
      ];
      for (const f of objectFields) {
        const row = firstRow
          .locator('.settings-repo-row-detail label', { hasText: f.label })
          .first();
        const input = row.locator('input[type="text"]').first();
        await auditText({
          scope: 'conception',
          section: 'Repositories · object fields',
          field: f.label,
          expectedKey: `repositories.0.${f.subKey}`,
          filePath: conceptionPath,
          input,
          value: f.value,
        });
      }

      // Surface "pinned_branch is in schema but not in UI" as a finding.
      const pinnedRow = firstRow
        .locator('.settings-repo-row-detail label', { hasText: 'Pinned branch' });
      const pinnedCount = await pinnedRow.count();
      findings.push({
        scope: 'conception',
        section: 'Repositories · object fields',
        field: 'Pinned branch (schema vs UI)',
        expectedKey: '<repo-row input>',
        expectedValue: '>=1 matching label',
        observed: pinnedCount,
        status: pinnedCount > 0 ? 'ok' : 'absent',
        detail:
          pinnedCount === 0
            ? 'config-schema.ts:21 declares pinned_branch on RawRepo but repo-row.tsx renders no input for it.'
            : undefined,
      });
    }

    // ---- Inheritance badge text after writes ---------------------------
    {
      // theme is overridden on the conception side (light vs. global dark).
      const themeBadge = conceptionPanel
        .locator('section#settings-section-appearance\\:conception .settings-section-subhead', {
          hasText: 'Theme',
        })
        .first()
        .locator('.settings-badge');
      try {
        const text = (await themeBadge.textContent()) ?? '';
        findings.push({
          scope: 'conception',
          section: 'Appearance · badge',
          field: 'Theme badge (after override)',
          expectedKey: '.settings-badge[theme]',
          expectedValue: 'Overridden',
          observed: text.trim(),
          status: text.trim() === 'Overridden' ? 'ok' : 'mismatch',
        });
      } catch (err) {
        findings.push({
          scope: 'conception',
          section: 'Appearance · badge',
          field: 'Theme badge (after override)',
          expectedKey: '.settings-badge[theme]',
          expectedValue: 'Overridden',
          observed: undefined,
          status: 'error',
          detail: (err as Error).message,
        });
      }
    }

    // ---- Remove-override (Theme) ---------------------------------------
    {
      const themeSubhead = conceptionPanel
        .locator('section#settings-section-appearance\\:conception .settings-section-subhead', {
          hasText: 'Theme',
        })
        .first();
      const removeBtn = themeSubhead.locator('button.settings-remove-override');
      try {
        await removeBtn.click({ timeout: 3000 });
        await commitSave(booted.window);
        const parsed = await waitForFile(
          conceptionPath,
          (p) => !Object.prototype.hasOwnProperty.call(p, 'theme'),
        );
        const present = Object.prototype.hasOwnProperty.call(parsed, 'theme');
        findings.push({
          scope: 'conception',
          section: 'Appearance · remove-override',
          field: 'Reset theme to global',
          expectedKey: 'theme',
          expectedValue: '<key absent>',
          observed: present ? parsed.theme : '<key absent>',
          status: present ? 'mismatch' : 'ok',
        });
      } catch (err) {
        findings.push({
          scope: 'conception',
          section: 'Appearance · remove-override',
          field: 'Reset theme to global',
          expectedKey: 'theme',
          expectedValue: '<key absent>',
          observed: undefined,
          status: 'error',
          detail: (err as Error).message,
        });
      }
    }

    // ---- Open externally button fires openPath -------------------------
    {
      // Hook openPath at the main-process IPC layer — contextBridge freezes
      // window.condash, so a renderer-side override silently no-ops.
      await booted.app.evaluate(({ ipcMain }) => {
        const calls: string[] = [];
        ipcMain.removeHandler('openPath');
        ipcMain.handle('openPath', async (_evt, target: string) => {
          calls.push(target);
        });
        (globalThis as unknown as { __auditOpenCalls: string[] }).__auditOpenCalls = calls;
      });

      // Click Open externally on the Conception tab.
      const openBtn = modal.locator('.settings-rail-actions button.modal-button', {
        hasText: 'Open externally',
      });
      try {
        await safeScroll(openBtn);
        await openBtn.click({ timeout: 3000, force: true });
        await booted.window.waitForTimeout(300);
        const calls = (await booted.app.evaluate(
          () =>
            (globalThis as unknown as { __auditOpenCalls: string[] }).__auditOpenCalls ?? [],
        )) as string[];
        const last = calls[calls.length - 1];
        findings.push({
          scope: 'conception',
          section: 'Open externally',
          field: 'Conception tab → openPath',
          expectedKey: '<IPC openPath>',
          expectedValue: conceptionPath,
          observed: last,
          status: last === conceptionPath ? 'ok' : last ? 'mismatch' : 'absent',
        });
      } catch (err) {
        findings.push({
          scope: 'conception',
          section: 'Open externally',
          field: 'Conception tab → openPath',
          expectedKey: '<IPC openPath>',
          expectedValue: conceptionPath,
          observed: undefined,
          status: 'error',
          detail: (err as Error).message,
        });
      }
    }

    await snapshot('end', settingsPath, conceptionPath);
    // ---- Write findings -----------------------------------------------
    await persistFindings();
  } finally {
    clearInterval(flushTimer);
    await persistFindings().catch(() => undefined);
    await booted.cleanup();
  }
});

function labelText(key: 'projects' | 'code' | 'knowledge' | 'resources' | 'skills'): string {
  switch (key) {
    case 'projects':
      return 'Project cards';
    case 'code':
      return 'Code cards';
    case 'knowledge':
      return 'Knowledge cards';
    case 'resources':
      return 'Resource cards';
    case 'skills':
      return 'Skill cards';
  }
}
