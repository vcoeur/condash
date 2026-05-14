import { describe, expect, it } from 'vitest';
import {
  configSchema,
  migrateRawSettings,
  validateAndCanonicaliseConceptionConfig,
} from './config-schema';

describe('configSchema repoEntry', () => {
  it('accepts the new env / install / pinned_branch fields', () => {
    const result = configSchema.safeParse({
      repositories: [
        {
          name: 'frontend',
          install: 'npm install',
          pinned_branch: 'main',
          env: ['.env', '.env.local'],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const repo = result.data.repositories?.[0];
      expect(typeof repo).toBe('object');
      if (repo && typeof repo !== 'string' && 'name' in repo) {
        expect(repo.env).toEqual(['.env', '.env.local']);
        expect(repo.install).toBe('npm install');
        expect(repo.pinned_branch).toBe('main');
      }
    }
  });

  it('rejects an env array containing an empty string', () => {
    const result = configSchema.safeParse({
      repositories: [{ name: 'frontend', env: ['.env', ''] }],
    });
    expect(result.success).toBe(false);
  });

  it('still rejects unknown fields under a repo entry', () => {
    const result = configSchema.safeParse({
      repositories: [{ name: 'frontend', not_a_field: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('still accepts the bare-string repo shape', () => {
    const result = configSchema.safeParse({
      repositories: ['standalone-repo'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects the legacy primary/secondary bucket shape', () => {
    const result = configSchema.safeParse({
      repositories: { primary: ['legacy-repo'] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a `{ section: "…" }` marker at the top level', () => {
    const result = configSchema.safeParse({
      repositories: [
        { section: 'Sites' },
        { name: 'alicepeintures.com', run: 'make dev' },
        { section: 'Tools' },
        'condash',
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty section name', () => {
    const result = configSchema.safeParse({
      repositories: [{ section: '' }, 'condash'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a section marker inside `submodules`', () => {
    const result = configSchema.safeParse({
      repositories: [
        {
          name: 'parent',
          submodules: [{ section: 'Inner' }, { name: 'child' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a section marker carrying any other field', () => {
    const result = configSchema.safeParse({
      repositories: [{ section: 'Sites', collapsed: true }],
    });
    expect(result.success).toBe(false);
  });
});

describe('configSchema resources_path / skills_path', () => {
  it('accepts plain relative paths', () => {
    const result = configSchema.safeParse({
      resources_path: 'resources',
      skills_path: '.claude/skills',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a nested relative path', () => {
    const result = configSchema.safeParse({ resources_path: 'docs/resources' });
    expect(result.success).toBe(true);
  });

  it('rejects an absolute path', () => {
    const result = configSchema.safeParse({ resources_path: '/etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = configSchema.safeParse({ skills_path: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a path containing ".."', () => {
    const result = configSchema.safeParse({ resources_path: '../escape' });
    expect(result.success).toBe(false);
  });

  it('rejects a deeper path containing a ".." segment', () => {
    const result = configSchema.safeParse({ skills_path: 'a/../b' });
    expect(result.success).toBe(false);
  });
});

describe('migrateRawSettings — dropped terminal.logging fields', () => {
  it('strips a stale `maxFileMb` left over from pre-v2.23.0 settings', () => {
    const migrated = migrateRawSettings({
      terminal: { logging: { retentionDays: 28, maxDirMb: 10000, maxFileMb: 5 } },
    }) as { terminal: { logging: Record<string, unknown> } };
    expect(migrated.terminal.logging).toEqual({ retentionDays: 28, maxDirMb: 10000 });
    expect('maxFileMb' in migrated.terminal.logging).toBe(false);
  });

  it('strips a stale `ansiPolicy` left over from pre-v2.23.0 settings', () => {
    const migrated = migrateRawSettings({
      terminal: { logging: { ansiPolicy: 'stripped' } },
    }) as { terminal: { logging: Record<string, unknown> } };
    expect(migrated.terminal.logging).toEqual({});
  });

  it('lets `validateAndCanonicaliseConceptionConfig` re-serialise a legacy maxFileMb body', () => {
    // Without the migration this would throw `terminal.logging.maxFileMb —
    // Unrecognised key` and block every Settings-modal save on conceptions
    // upgraded from v2.22 or earlier.
    const json = JSON.stringify({
      terminal: { logging: { retentionDays: 28, maxDirMb: 10000, maxFileMb: 5 } },
    });
    const canon = validateAndCanonicaliseConceptionConfig(json);
    const parsed = JSON.parse(canon);
    expect(parsed.terminal.logging).toEqual({ retentionDays: 28, maxDirMb: 10000 });
  });
});

describe('migrateRawSettings — invalid launcher entries', () => {
  it('drops a launcher entry with no command (title-only), preserving valid siblings', () => {
    // Pre-v2.28.2 the renderer could persist `{ symbol, title }` when the
    // user typed a title without a command. The strict schema then rejects
    // the file with `terminal.launchers.<i>.command — expected string,
    // received undefined`, locking the Settings modal out of every save.
    const migrated = migrateRawSettings({
      terminal: {
        launchers: [
          { symbol: 'mu', title: 'Kimi' },
          { symbol: 'lambda', command: 'claude', title: 'Claude' },
        ],
      },
    }) as { terminal: { launchers: unknown[] } };
    expect(migrated.terminal.launchers).toEqual([
      { symbol: 'lambda', command: 'claude', title: 'Claude' },
    ]);
  });

  it('drops a launcher entry with an empty-string command', () => {
    const migrated = migrateRawSettings({
      terminal: { launchers: [{ symbol: 'mu', command: '   ', title: 'Kimi' }] },
    }) as { terminal: Record<string, unknown> };
    expect('launchers' in migrated.terminal).toBe(false);
  });

  it('removes the launchers key entirely when every entry is invalid', () => {
    const migrated = migrateRawSettings({
      terminal: { launchers: [{ symbol: 'mu', title: 'Kimi' }] },
    }) as { terminal: Record<string, unknown> };
    expect('launchers' in migrated.terminal).toBe(false);
  });

  it('lets `validateAndCanonicaliseConceptionConfig` re-serialise a body with one bad launcher', () => {
    // Without the scrub this throws `terminal.launchers.0.command —
    // expected string, received undefined` (the symptom in the v2.30.0
    // user report) and the Settings modal cannot save.
    const json = JSON.stringify({
      terminal: {
        launchers: [
          { symbol: 'mu', title: 'Kimi' },
          { symbol: 'lambda', command: 'claude' },
        ],
      },
    });
    const canon = validateAndCanonicaliseConceptionConfig(json);
    const parsed = JSON.parse(canon);
    expect(parsed.terminal.launchers).toEqual([{ symbol: 'lambda', command: 'claude' }]);
  });
});
