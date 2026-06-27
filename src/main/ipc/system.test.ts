/**
 * System-IPC trust-boundary tests: `openConception` must refuse to re-point
 * the trust root (`lastConceptionPath`) at anything that isn't a conception,
 * and the shell-out verbs `openPath` / `showInFolder` must stay bounded to
 * the workspace roots (with the single settings.json exemption). Handlers
 * are captured off a mocked `ipcMain.handle` — same pattern as logs.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestGlobals {
  __testConception?: string | null;
  __testSettingsPath?: string;
}
const testGlobals = globalThis as TestGlobals;

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: () => '/tmp/electron-app',
    getAppPath: () => '/tmp/electron-app',
    getName: () => 'condash',
    getVersion: () => '0.0.0-test',
    quit: vi.fn(),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: {
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock('../export-pdf', () => ({
  htmlToPdf: vi.fn(async () => Buffer.from('%PDF-fake')),
}));

vi.mock('../settings', () => ({
  readSettings: vi.fn(async () => ({
    lastConceptionPath: testGlobals.__testConception ?? null,
    recentConceptionPaths: [],
  })),
  updateSettings: vi.fn(async () => undefined),
  prependRecent: vi.fn((list: string[] | undefined, path: string) => [path, ...(list ?? [])]),
  removeRecent: vi.fn((list: string[] | undefined) => list ?? []),
  settingsPath: vi.fn(() => testGlobals.__testSettingsPath ?? '/nonexistent/settings.json'),
}));

vi.mock('../effective-config', () => ({
  resolveConceptionConfigPath: vi.fn(async (p: string) => join(p, '.condash', 'settings.json')),
  getEffectiveConceptionConfig: vi.fn(async () => ({})),
}));

vi.mock('../watcher', () => ({ setWatchedConception: vi.fn(async () => undefined) }));
vi.mock('../repo-watchers', () => ({ disposeRepoWatchers: vi.fn(async () => undefined) }));

let handlers: Record<string, (...args: any[]) => Promise<unknown>>;
let onConceptionPicked: ReturnType<typeof vi.fn>;
let tmp: string;
let conception: string;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

const webviewEvent = {
  sender: { getType: () => 'webview' },
  senderFrame: { url: 'file:///some/file.pdf', parent: null },
};

beforeEach(async () => {
  vi.clearAllMocks();
  handlers = {};
  const { ipcMain } = await import('electron');
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );

  tmp = mkdtempSync(join(tmpdir(), 'condash-system-ipc-'));
  conception = join(tmp, 'conception');
  mkdirSync(join(conception, 'projects'), { recursive: true });
  mkdirSync(join(conception, '.condash'), { recursive: true });
  writeFileSync(join(conception, '.condash', 'settings.json'), '{}\n');
  writeFileSync(join(conception, 'note.md'), 'inside\n');
  testGlobals.__testConception = conception;
  testGlobals.__testSettingsPath = join(tmp, 'settings.json');
  writeFileSync(testGlobals.__testSettingsPath, '{}\n');

  onConceptionPicked = vi.fn();
  const { registerSystemIpc } = await import('./system');
  registerSystemIpc({ onConceptionPicked });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete testGlobals.__testConception;
  delete testGlobals.__testSettingsPath;
});

describe('openConception', () => {
  it('rejects a filesystem root', async () => {
    await expect(handlers.openConception(trustedEvent, '/')).rejects.toThrow(
      /refusing a filesystem root/,
    );
  });

  it('rejects a non-existent path', async () => {
    await expect(handlers.openConception(trustedEvent, join(tmp, 'nope'))).rejects.toThrow(
      /does not resolve/,
    );
  });

  it('rejects an existing directory without conception markers', async () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    await expect(handlers.openConception(trustedEvent, plain)).rejects.toThrow(
      /does not look like a conception/,
    );
  });

  it('rejects an empty path', async () => {
    await expect(handlers.openConception(trustedEvent, '')).rejects.toThrow(
      /expected a non-empty string/,
    );
  });

  it('rejects an untrusted (webview) sender before doing any work', async () => {
    await expect(handlers.openConception(webviewEvent, conception)).rejects.toThrow(
      /not an app window/,
    );
    expect(onConceptionPicked).not.toHaveBeenCalled();
  });

  it('accepts a directory carrying the conception markers and switches to it', async () => {
    const picked = (await handlers.openConception(trustedEvent, conception)) as string;
    expect(picked).toBe((await fs.realpath(conception)).split('\\').join('/'));
    const { updateSettings } = await import('../settings');
    expect(updateSettings).toHaveBeenCalled();
    const { setWatchedConception } = await import('../watcher');
    expect(setWatchedConception).toHaveBeenCalledWith(picked);
    expect(onConceptionPicked).toHaveBeenCalledWith(picked);
  });

  it('accepts a directory with only a legacy condash.json marker', async () => {
    const legacy = join(tmp, 'legacy');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'condash.json'), '{}\n');
    await expect(handlers.openConception(trustedEvent, legacy)).resolves.toBeTruthy();
  });
});

describe('openPath', () => {
  it('rejects URL-shaped targets', async () => {
    await expect(handlers.openPath(trustedEvent, 'https://example.com/x')).rejects.toThrow(
      /must be a path, not a URL/,
    );
  });

  it('rejects paths outside the workspace roots', async () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    await expect(handlers.openPath(trustedEvent, join(outside, 'secret.txt'))).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it('opens a file under the conception', async () => {
    await handlers.openPath(trustedEvent, join(conception, 'note.md'));
    const { shell } = await import('electron');
    expect(shell.openPath).toHaveBeenCalledWith(await fs.realpath(join(conception, 'note.md')));
  });

  it('allows the per-machine settings.json by exact match', async () => {
    await handlers.openPath(trustedEvent, testGlobals.__testSettingsPath as string);
    const { shell } = await import('electron');
    expect(shell.openPath).toHaveBeenCalledWith(
      await fs.realpath(testGlobals.__testSettingsPath as string),
    );
  });
});

describe('exportNotePdf', () => {
  it('returns null without printing when the save dialog is cancelled', async () => {
    const { dialog } = await import('electron');
    (dialog.showSaveDialog as any).mockResolvedValue({ canceled: true });
    const result = await handlers.exportNotePdf(trustedEvent, '/c/note.md', '<html></html>');
    expect(result).toBeNull();
    const { htmlToPdf } = await import('../export-pdf');
    expect(htmlToPdf).not.toHaveBeenCalled();
  });

  it('prints and writes the PDF to the picked path', async () => {
    const target = join(tmp, 'out.pdf');
    const { dialog } = await import('electron');
    (dialog.showSaveDialog as any).mockResolvedValue({ canceled: false, filePath: target });
    const result = await handlers.exportNotePdf(trustedEvent, '/c/note.md', '<html></html>');
    expect(result).toBe(target.split('\\').join('/'));
    expect(await fs.readFile(target, 'utf8')).toBe('%PDF-fake');
    // The dialog defaults to <note-name>.pdf next to the source note.
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: '/c/note.pdf' }),
    );
  });

  it('rejects an oversized document before opening the dialog', async () => {
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1);
    await expect(handlers.exportNotePdf(trustedEvent, '/c/note.md', huge)).rejects.toThrow(
      /size cap/,
    );
    const { dialog } = await import('electron');
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects empty arguments', async () => {
    await expect(handlers.exportNotePdf(trustedEvent, '', '<html></html>')).rejects.toThrow(
      /expected a non-empty string/,
    );
    await expect(handlers.exportNotePdf(trustedEvent, '/c/note.md', '')).rejects.toThrow(
      /expected a non-empty string/,
    );
  });

  it('rejects an untrusted (webview) sender', async () => {
    await expect(
      handlers.exportNotePdf(webviewEvent, '/c/note.md', '<html></html>'),
    ).rejects.toThrow(/not an app window/);
  });
});

describe('showInFolder', () => {
  it('rejects paths outside the workspace roots', async () => {
    await expect(handlers.showInFolder(trustedEvent, '/etc/passwd')).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it('reveals a file under the conception', async () => {
    await handlers.showInFolder(trustedEvent, join(conception, 'note.md'));
    const { shell } = await import('electron');
    expect(shell.showItemInFolder).toHaveBeenCalledWith(
      await fs.realpath(join(conception, 'note.md')),
    );
  });
});
