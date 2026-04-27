import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');

export interface BootedApp {
  app: ElectronApplication;
  window: Page;
  conceptionDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

/**
 * Build a tiny conception fixture (one project, one knowledge note) and launch
 * the production Electron build pointed at it.
 */
export async function bootApp(options: { extraConfig?: Record<string, unknown> } = {}): Promise<BootedApp> {
  const conceptionDir = await mkdtemp(join(tmpdir(), 'condash-test-conception-'));
  const userDataDir = await mkdtemp(join(tmpdir(), 'condash-test-userdata-'));

  await mkdir(join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample'), { recursive: true });
  await writeFile(
    join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample', 'README.md'),
    `# Sample project\n\n**Status**: now\n**Kind**: project\n\n## Summary\n\nSample fixture project.\n\n## Steps\n\n- [ ] First step\n- [ ] Second step\n`,
    'utf8',
  );
  await mkdir(join(conceptionDir, 'knowledge'), { recursive: true });
  await writeFile(
    join(conceptionDir, 'knowledge', 'index.md'),
    `# knowledge\n\nFixture knowledge index.\n`,
    'utf8',
  );
  await writeFile(
    join(conceptionDir, 'configuration.json'),
    JSON.stringify({ ...(options.extraConfig ?? {}) }, null, 2) + '\n',
    'utf8',
  );

  // Pre-seed the per-machine settings.json so the app boots straight onto the
  // dashboard view (no folder picker required). The subdir matches
  // package.json's `name` field — that's how Electron picks
  // `app.getPath('userData')`.
  await mkdir(join(userDataDir, 'condash'), { recursive: true });
  await writeFile(
    join(userDataDir, 'condash', 'settings.json'),
    JSON.stringify({ conceptionPath: conceptionDir, theme: 'system' }, null, 2) + '\n',
    'utf8',
  );

  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: repoRoot,
    env: {
      ...process.env,
      // Electron honours XDG_CONFIG_HOME for app.getPath('userData') on Linux.
      XDG_CONFIG_HOME: userDataDir,
      CONDASH_FORCE_PROD: '1',
    },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  return {
    app,
    window,
    conceptionDir,
    userDataDir,
    cleanup: async () => {
      await app.close().catch(() => undefined);
      await rm(conceptionDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
