/**
 * Bootstrap-IPC shape + parity (review finding S6). The single `bootstrap`
 * handler must return the active conception path plus every mount-time settings
 * value in one round-trip, and each field must equal what the individual getter
 * would return — otherwise a store seeded from the bundle would diverge from a
 * later reload through the getter. This test registers both the bootstrap and
 * the settings IPC over a temp settings.json and asserts field-by-field parity.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/electron-app' },
}));

let tmp: string;
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;
let settingsPathValue: string;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

async function writeSettings(content: object): Promise<void> {
  await fs.writeFile(settingsPathValue, JSON.stringify(content));
}

beforeEach(async () => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-bootstrap-ipc-'));
  settingsPathValue = join(tmp, 'settings.json');
  const isolatedTmp = tmp;
  vi.doMock('../user-data-dir', () => ({ userDataDir: () => isolatedTmp }));

  handlers = {};
  const { ipcMain } = await import('electron');
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );
  const { registerSettingsIpc } = await import('./settings');
  const { registerBootstrapIpc } = await import('./bootstrap');
  registerSettingsIpc({ onLayoutChange: () => undefined });
  registerBootstrapIpc();
});

afterEach(async () => {
  try {
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
  } catch {
    /* Module not loaded yet — fine. */
  }
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('../user-data-dir');
});

describe('bootstrap IPC', () => {
  const richSettings = {
    lastConceptionPath: null,
    recentConceptionPaths: [],
    theme: 'dark',
    terminal: { shell: 'bash', screenshot_dir: '/tmp/shots' },
    layout: {
      projects: true,
      leftView: 'tasks',
      working: 'code',
      terminal: false,
      projectsWidth: 400,
    },
    welcome: { dismissed: true },
    cardMinWidth: { projects: 700 },
    treeExpansion: { knowledge: ['a/b'], skillsUser: ['x'] },
    selectedBranches: ['feat-1', 'feat-1', 'feat-2'],
    branchFilterStickyAll: false,
    skillsActiveScope: 'user',
  };

  it('returns the same value as each individual getter (shape parity)', async () => {
    await writeSettings(richSettings);
    const boot = (await handlers.bootstrap(trustedEvent)) as Record<string, unknown>;

    // No active conception here → null, same as getConceptionPath.
    expect(boot.conceptionPath).toBeNull();
    expect(boot.theme).toEqual(await handlers.getTheme(trustedEvent));
    expect(boot.layout).toEqual(await handlers.getLayout(trustedEvent));
    expect(boot.welcomeDismissed).toEqual(await handlers.getWelcomeDismissed(trustedEvent));
    expect(boot.cardMinWidth).toEqual(await handlers.getCardMinWidth(trustedEvent));
    expect(boot.treeExpansion).toEqual(await handlers.getTreeExpansion(trustedEvent));
    expect(boot.selectedBranches).toEqual(await handlers.getSelectedBranches(trustedEvent));
    expect(boot.branchFilterStickyAll).toEqual(
      await handlers.getBranchFilterStickyAll(trustedEvent),
    );
    expect(boot.skillsActiveScope).toEqual(await handlers.getSkillsActiveScope(trustedEvent));
  });

  it('carries the config-bound reads (open-with + terminal prefs)', async () => {
    await writeSettings(richSettings);
    const { getTerminalPrefs } = await import('../terminals');
    const boot = (await handlers.bootstrap(trustedEvent)) as Record<string, unknown>;
    // No active conception → open-with resolves empty; terminal prefs fall back
    // to the global settings.terminal (same as termGetPrefs).
    expect(boot.openWith).toEqual({});
    expect(boot.terminalPrefs).toEqual(await getTerminalPrefs());
    expect(boot.terminalPrefs).toMatchObject({ shell: 'bash' });
  });

  it('posix-normalises the conception path, matching getConceptionPath', async () => {
    // A backslash-bearing path (Windows, or the CONDASH_CONCEPTION_PATH env
    // override which is injected unnormalised) must surface in posix form — the
    // renderer splits paths on `/` and never handles per-OS separators.
    await writeSettings({ ...richSettings, lastConceptionPath: 'C:\\Users\\alice\\conception' });
    const boot = (await handlers.bootstrap(trustedEvent)) as Record<string, unknown>;
    expect(boot.conceptionPath).toBe('C:/Users/alice/conception');
  });

  it('returns getter-equivalent defaults when settings.json is absent', async () => {
    // No writeSettings() → readSettings falls back to defaults. The bundle must
    // deliver the same defaulted values the individual getters would, so a boot
    // with a fresh/missing settings file seeds correct prefs.
    const boot = (await handlers.bootstrap(trustedEvent)) as Record<string, unknown>;
    expect(boot.conceptionPath).toBeNull();
    expect(boot.theme).toEqual(await handlers.getTheme(trustedEvent));
    expect(boot.layout).toEqual(await handlers.getLayout(trustedEvent));
    expect(boot.welcomeDismissed).toEqual(await handlers.getWelcomeDismissed(trustedEvent));
    expect(boot.cardMinWidth).toEqual(await handlers.getCardMinWidth(trustedEvent));
    expect(boot.treeExpansion).toEqual(await handlers.getTreeExpansion(trustedEvent));
    expect(boot.selectedBranches).toEqual(await handlers.getSelectedBranches(trustedEvent));
    expect(boot.branchFilterStickyAll).toEqual(
      await handlers.getBranchFilterStickyAll(trustedEvent),
    );
    expect(boot.skillsActiveScope).toEqual(await handlers.getSkillsActiveScope(trustedEvent));
    expect(boot.openWith).toEqual({});
  });

  it('exposes exactly the documented BootstrapData keys', async () => {
    await writeSettings(richSettings);
    const boot = (await handlers.bootstrap(trustedEvent)) as Record<string, unknown>;
    expect(Object.keys(boot).sort()).toEqual(
      [
        'branchFilterStickyAll',
        'cardMinWidth',
        'conceptionPath',
        'layout',
        'openWith',
        'projectCardTitleFont',
        'selectedBranches',
        'skillsActiveScope',
        'terminalPrefs',
        'theme',
        'treeExpansion',
        'welcomeDismissed',
      ].sort(),
    );
    // projectCardTitleFont falls back to the built-in default when unset.
    expect(boot.projectCardTitleFont).toBe('default');
    // Deduped selectedBranches, exactly as getSelectedBranches returns.
    expect(boot.selectedBranches).toEqual(['feat-1', 'feat-2']);
    // cardMinWidth is fully resolved (every pane present, missing keys defaulted).
    expect(Object.keys(boot.cardMinWidth as object).sort()).toEqual(
      [
        'code',
        'deliverables',
        'knowledge',
        'logs',
        'projects',
        'resources',
        'skills',
        'tasks',
      ].sort(),
    );
  });
});
