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

describe('configSchema dropped path keys', () => {
  // Both `resources_path` and `skills_path` were dropped in the reframe —
  // the Resources pane is hard-coded to `<root>/resources/` and the Skills
  // pane reads agedum sources at `<root>/.agents/skills/`. The schema is
  // strict, so either key on disk now fails parsing.
  it('rejects `resources_path` (no longer configurable)', () => {
    const result = configSchema.safeParse({ resources_path: 'resources' });
    expect(result.success).toBe(false);
  });

  it('rejects `skills_path` (no longer configurable)', () => {
    const result = configSchema.safeParse({ skills_path: '.claude/skills' });
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

describe('migrateRawSettings — launchers replaced by agents', () => {
  it('drops the legacy `launchers` and `launcher_command` keys', () => {
    const migrated = migrateRawSettings({
      terminal: {
        launcher_command: 'claude',
        launchers: [{ label: 'λ', command: 'claude' }],
        shell: '/bin/bash',
      },
    }) as { terminal: Record<string, unknown> };
    expect('launchers' in migrated.terminal).toBe(false);
    expect('launcher_command' in migrated.terminal).toBe(false);
    // Unrelated keys survive.
    expect(migrated.terminal.shell).toBe('/bin/bash');
  });

  it('renames an action `launcher` binding to `agent`', () => {
    const migrated = migrateRawSettings({
      terminal: {
        projectActions: [{ label: 'Review', template: 'review {slug}', launcher: 'Claude' }],
        newProjectActions: [{ label: 'Start', template: 'start', launcher: 'Kimi' }],
      },
    }) as {
      terminal: {
        projectActions: Record<string, unknown>[];
        newProjectActions: Record<string, unknown>[];
      };
    };
    expect(migrated.terminal.projectActions[0]).toEqual({
      label: 'Review',
      template: 'review {slug}',
      agent: 'Claude',
    });
    expect(migrated.terminal.newProjectActions[0].agent).toBe('Kimi');
    expect('launcher' in migrated.terminal.projectActions[0]).toBe(false);
  });

  it('lets `validateAndCanonicaliseConceptionConfig` re-serialise a body carrying legacy launchers', () => {
    // The strict schema would reject the stale `launchers` key outright; the
    // migration drops it first so the Settings modal can still save.
    const json = JSON.stringify({
      terminal: { launchers: [{ label: 'λ', command: 'claude' }], shell: '/bin/zsh' },
    });
    const canon = validateAndCanonicaliseConceptionConfig(json);
    const parsed = JSON.parse(canon);
    expect(parsed.terminal.launchers).toBeUndefined();
    expect(parsed.terminal.shell).toBe('/bin/zsh');
  });
});
