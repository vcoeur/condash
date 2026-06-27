import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conceptionConfigWritePath,
  getEffectiveConceptionConfig,
  readConceptionConfigRaw,
  resolveConceptionConfigPath,
} from './effective-config';
import { CONDASH_DIR, condashSettingsPath } from './condash-dir';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-eff-cfg-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveConceptionConfigPath', () => {
  it('returns .condash/settings.json when it exists', async () => {
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(condashSettingsPath(tmp));
  });

  it('falls back to condash.json when the primary is absent', async () => {
    writeFileSync(join(tmp, 'condash.json'), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(join(tmp, 'condash.json'));
  });

  it('falls back to configuration.json when only the legacy² file exists', async () => {
    writeFileSync(join(tmp, 'configuration.json'), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(join(tmp, 'configuration.json'));
  });

  it('returns the new canonical path for an empty conception (caller may seed)', async () => {
    expect(await resolveConceptionConfigPath(tmp)).toBe(condashSettingsPath(tmp));
  });

  it('prefers .condash/settings.json over both legacies when all three are present', async () => {
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), '{}\n');
    writeFileSync(join(tmp, 'condash.json'), '{}\n');
    writeFileSync(join(tmp, 'configuration.json'), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(condashSettingsPath(tmp));
  });

  it('skips a tombstoned legacy file the way readConceptionConfigRaw does', async () => {
    writeFileSync(
      join(tmp, 'condash.json'),
      JSON.stringify({ _moved_to: `${CONDASH_DIR}/settings.json` }),
    );
    writeFileSync(join(tmp, 'configuration.json'), '{"src":"cf"}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(join(tmp, 'configuration.json'));
  });

  it('returns the canonical path when every candidate is a tombstone', async () => {
    writeFileSync(join(tmp, 'condash.json'), JSON.stringify({ _moved_at: 'x' }));
    expect(await resolveConceptionConfigPath(tmp)).toBe(condashSettingsPath(tmp));
  });
});

describe('conceptionConfigWritePath', () => {
  it('always returns the new canonical path', () => {
    expect(conceptionConfigWritePath(tmp)).toBe(condashSettingsPath(tmp));
  });
});

describe('readConceptionConfigRaw', () => {
  it('returns the parsed primary when present', async () => {
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), '{"workspace_path":"/x"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ workspace_path: '/x' });
  });

  it('falls back to condash.json when primary missing', async () => {
    writeFileSync(join(tmp, 'condash.json'), '{"foo":"bar"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ foo: 'bar' });
  });

  it('falls back to configuration.json when condash.json is missing', async () => {
    writeFileSync(join(tmp, 'configuration.json'), '{"src":"cf"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ src: 'cf' });
  });

  it('treats tombstones as absent and probes further', async () => {
    writeFileSync(
      join(tmp, 'condash.json'),
      JSON.stringify({ _moved_to: `${CONDASH_DIR}/settings.json` }),
    );
    writeFileSync(join(tmp, 'configuration.json'), '{"foo":"bar"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ foo: 'bar' });
  });

  it('returns {} when nothing is present', async () => {
    expect(await readConceptionConfigRaw(tmp)).toEqual({});
  });
});

describe('getEffectiveConceptionConfig', () => {
  it('spreads the two disjoint files into one view (no key overlap)', async () => {
    const global = join(tmp, 'settings.json');
    writeFileSync(
      global,
      JSON.stringify({
        theme: 'dark',
        terminal: { shell: '/bin/zsh', screenshot_dir: '/home/alice/Pictures' },
      }),
    );
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(
      condashSettingsPath(tmp),
      JSON.stringify({ workspace_path: '/home/alice/src', repositories: ['condash'] }),
    );
    const eff = await getEffectiveConceptionConfig(tmp, global);
    // Global-owned keys come straight from the global file…
    expect(eff.theme).toBe('dark');
    expect(eff.terminal).toEqual({ shell: '/bin/zsh', screenshot_dir: '/home/alice/Pictures' });
    // …and conception-owned keys from the conception file. No precedence.
    expect(eff.workspace_path).toBe('/home/alice/src');
    expect((eff as { repositories?: unknown }).repositories).toEqual(['condash']);
  });

  it('takes a global-only key from the global file', async () => {
    const global = join(tmp, 'settings.json');
    writeFileSync(global, JSON.stringify({ theme: 'light', terminal: { shell: '/bin/bash' } }));
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), JSON.stringify({ workspace_path: '/x' }));
    const eff = await getEffectiveConceptionConfig(tmp, global);
    expect(eff.theme).toBe('light');
    expect(eff.terminal).toEqual({ shell: '/bin/bash' });
  });

  it('takes a conception-only key from the conception file', async () => {
    const global = join(tmp, 'settings.json');
    writeFileSync(global, JSON.stringify({ theme: 'dark' }));
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(
      condashSettingsPath(tmp),
      JSON.stringify({ workspace_path: '/home/alice/src', repositories: ['a', 'b'] }),
    );
    const eff = await getEffectiveConceptionConfig(tmp, global);
    expect(eff.workspace_path).toBe('/home/alice/src');
    expect((eff as { repositories?: unknown }).repositories).toEqual(['a', 'b']);
  });

  it('never surfaces the path-tracking keys (global-only, excluded from the view)', async () => {
    const global = join(tmp, 'settings.json');
    writeFileSync(
      global,
      JSON.stringify({
        theme: 'dark',
        lastConceptionPath: '/home/alice/src/conception',
        recentConceptionPaths: ['/home/alice/src/conception', '/home/alice/src/other'],
      }),
    );
    const eff = await getEffectiveConceptionConfig(tmp, global);
    expect(eff.theme).toBe('dark');
    expect('lastConceptionPath' in eff).toBe(false);
    expect('recentConceptionPaths' in eff).toBe(false);
  });

  it('reads the conception side from a legacy condash.json fallback', async () => {
    const global = join(tmp, 'settings.json');
    writeFileSync(global, JSON.stringify({ theme: 'dark' }));
    // No .condash/settings.json — only the legacy condash.json at the root.
    writeFileSync(join(tmp, 'condash.json'), JSON.stringify({ workspace_path: '/legacy/src' }));
    const eff = await getEffectiveConceptionConfig(tmp, global);
    expect(eff.theme).toBe('dark');
    expect(eff.workspace_path).toBe('/legacy/src');
  });

  it('reads the conception side from a legacy configuration.json fallback', async () => {
    const global = join(tmp, 'settings.json');
    writeFileSync(global, JSON.stringify({ theme: 'dark' }));
    writeFileSync(
      join(tmp, 'configuration.json'),
      JSON.stringify({ worktrees_path: '/legacy/worktrees' }),
    );
    const eff = await getEffectiveConceptionConfig(tmp, global);
    expect(eff.worktrees_path).toBe('/legacy/worktrees');
  });

  it('drops legacy launchers / launcher_command on read (replaced by Agents)', async () => {
    const global = join(tmp, 'settings.json');
    writeFileSync(
      global,
      JSON.stringify({
        terminal: {
          launcher_command: 'stale',
          launchers: [{ label: 'λ', command: 'claude' }],
          shell: '/bin/bash',
        },
      }),
    );
    const eff = await getEffectiveConceptionConfig(tmp, global);
    expect(eff.terminal).toEqual({ shell: '/bin/bash' });
  });
});
