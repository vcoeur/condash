import { describe, expect, it } from 'vitest';
import {
  conceptionConfigSchema as configSchema,
  globalSettingsSchema,
  migrateRawSettings,
  validateAndCanonicaliseConceptionConfig,
  validateAndCanonicaliseGlobalSettings,
} from './config-schema';
import { CARD_MIN_WIDTH_KEYS, DEFAULT_CARD_MIN_WIDTH } from '../shared/types';

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

describe('configSchema agents', () => {
  it('accepts the optional favorite + promptFlags flags', () => {
    const result = configSchema.safeParse({
      agents: [
        { id: 'claude', label: 'Claude', command: 'claude', favorite: true },
        { id: 'kimi', label: 'Kimi', command: 'claude-kimi', promptFlags: true },
        { id: 'plain', label: 'Plain', command: 'opencode' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents?.[0].favorite).toBe(true);
      expect(result.data.agents?.[1].favorite).toBeUndefined();
    }
  });

  it('rejects an unknown agent field (strict)', () => {
    const result = configSchema.safeParse({
      agents: [{ id: 'claude', label: 'Claude', command: 'claude', favourite: true }],
    });
    expect(result.success).toBe(false);
  });

  it('round-trips favorite through the conception canonicaliser', () => {
    const canon = validateAndCanonicaliseConceptionConfig(
      JSON.stringify({
        agents: [{ id: 'claude', label: 'Claude', command: 'claude', favorite: true }],
      }),
    );
    expect(JSON.parse(canon).agents[0].favorite).toBe(true);
  });
});

describe('configSchema taskConfig (capability 1)', () => {
  it('accepts a per-task schedule + timeout + excludeFromLogs map', () => {
    const result = configSchema.safeParse({
      taskConfig: {
        'sample-task': { schedule: '2m', timeout: '1m', excludeFromLogs: true },
        'daily-journal': { schedule: '1h' },
        adopted: { excludeFromLogs: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty entry (task present but inert)', () => {
    expect(configSchema.safeParse({ taskConfig: { x: {} } }).success).toBe(true);
  });

  it('rejects unknown keys inside an entry', () => {
    const result = configSchema.safeParse({
      taskConfig: { x: { schedule: '2m', bogus: 1 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string timeout', () => {
    expect(configSchema.safeParse({ taskConfig: { x: { timeout: 120 } } }).success).toBe(false);
  });

  it('accepts a runMode of interactive or oneshot, rejects anything else', () => {
    expect(configSchema.safeParse({ taskConfig: { x: { runMode: 'interactive' } } }).success).toBe(
      true,
    );
    expect(configSchema.safeParse({ taskConfig: { x: { runMode: 'oneshot' } } }).success).toBe(
      true,
    );
    expect(configSchema.safeParse({ taskConfig: { x: { runMode: 'headless' } } }).success).toBe(
      false,
    );
  });

  it('accepts a boolean gateOnUpdatedTabs, rejects a non-boolean', () => {
    expect(
      configSchema.safeParse({ taskConfig: { x: { schedule: '2m', gateOnUpdatedTabs: true } } })
        .success,
    ).toBe(true);
    expect(
      configSchema.safeParse({ taskConfig: { x: { gateOnUpdatedTabs: 'yes' } } }).success,
    ).toBe(false);
  });

  it('rejects a non-string schedule / non-boolean excludeFromLogs', () => {
    expect(configSchema.safeParse({ taskConfig: { x: { schedule: 120 } } }).success).toBe(false);
    expect(configSchema.safeParse({ taskConfig: { x: { excludeFromLogs: 'yes' } } }).success).toBe(
      false,
    );
  });

  it('is accepted by the global settings schema too (shared field)', () => {
    expect(globalSettingsSchema.safeParse({ taskConfig: { x: { schedule: '30s' } } }).success).toBe(
      true,
    );
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

describe('migrateRawSettings — defunct top-level keys', () => {
  // `resources_path` / `skills_path` were dropped by the reframe; `skillsActiveTab`
  // is a defunct UI-state key. A real settings.json upgraded across those versions
  // still carries them, and the strict schema rejects them — so without stripping,
  // every Settings save throws `Unrecognized key`. (This was the reported bug.)
  it('strips `resources_path`, `skills_path` and `skillsActiveTab`, keeping live keys', () => {
    const migrated = migrateRawSettings({
      resources_path: 'resources',
      skills_path: '.claude/skills',
      skillsActiveTab: 'generic',
      workspace_path: '/home/alice/src/vcoeur',
    }) as Record<string, unknown>;
    expect('resources_path' in migrated).toBe(false);
    expect('skills_path' in migrated).toBe(false);
    expect('skillsActiveTab' in migrated).toBe(false);
    expect(migrated.workspace_path).toBe('/home/alice/src/vcoeur');
  });

  it('lets a conception save round-trip a legacy resources_path / skills_path body', () => {
    // Reproduces the reported failure: editing agents on the conception tab
    // canonicalises `.condash/settings.json`, which carried these two keys.
    const json = JSON.stringify({
      workspace_path: '/home/alice/src/vcoeur',
      resources_path: 'resources',
      skills_path: '.claude/skills',
      agents: [{ id: 'claude', label: 'Claude', command: 'agedum claude', promptFlags: true }],
    });
    const canon = validateAndCanonicaliseConceptionConfig(json);
    const parsed = JSON.parse(canon);
    expect('resources_path' in parsed).toBe(false);
    expect('skills_path' in parsed).toBe(false);
    expect(parsed.agents[0].promptFlags).toBe(true);
  });

  it('lets a global save keep `skillsActiveScope` while stripping defunct keys', () => {
    // The global tab carries `skillsActiveScope` (live UI state) plus the
    // orphaned `skillsActiveTab` and legacy `terminal.launcher_command`.
    const json = JSON.stringify({
      skillsActiveScope: 'user',
      skillsActiveTab: 'generic',
      terminal: { launcher_command: 'claude', shell: '/bin/bash' },
    });
    const canon = validateAndCanonicaliseGlobalSettings(json);
    const parsed = JSON.parse(canon);
    expect(parsed.skillsActiveScope).toBe('user');
    expect('skillsActiveTab' in parsed).toBe(false);
    expect('launcher_command' in parsed.terminal).toBe(false);
    expect(parsed.terminal.shell).toBe('/bin/bash');
  });

  it('accepts a valid `skillsActiveScope` and rejects an invalid one', () => {
    expect(globalSettingsSchema.safeParse({ skillsActiveScope: 'conception' }).success).toBe(true);
    expect(globalSettingsSchema.safeParse({ skillsActiveScope: 'bogus' }).success).toBe(false);
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

describe('configSchema cardMinWidth — every card grid is accepted', () => {
  // The reported bug: the Card-density UI grew from five panes to eight
  // (logs / tasks / deliverables added), but the schema's key list stayed at
  // five. Saving a Log/Task/Deliverable width on the conception tab threw
  // `condash.json: cardMinWidth — Unrecognized key: "logs"`. Drive every
  // canonical key through the schema so a future pane can't drift again.
  it('accepts every key in DEFAULT_CARD_MIN_WIDTH', () => {
    for (const key of CARD_MIN_WIDTH_KEYS) {
      const result = configSchema.safeParse({ cardMinWidth: { [key]: 500 } });
      expect(result.success, `cardMinWidth.${key} should be accepted`).toBe(true);
    }
  });

  it('accepts a full eight-key cardMinWidth object', () => {
    const result = configSchema.safeParse({ cardMinWidth: { ...DEFAULT_CARD_MIN_WIDTH } });
    expect(result.success).toBe(true);
  });

  it('still rejects an unknown cardMinWidth key (typo guard intact)', () => {
    const result = configSchema.safeParse({ cardMinWidth: { logz: 500 } });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive cardMinWidth value', () => {
    expect(configSchema.safeParse({ cardMinWidth: { logs: 0 } }).success).toBe(false);
    expect(configSchema.safeParse({ cardMinWidth: { logs: -10 } }).success).toBe(false);
  });

  it('lets a conception save round-trip a `logs` card width (the reported failure)', () => {
    // Reproduces the screenshot: editing the Log-cards min-width on the
    // conception tab canonicalises condash.json. Before the fix this threw
    // `condash.json: cardMinWidth — Unrecognized key: "logs"`.
    const json = JSON.stringify({ cardMinWidth: { logs: 500, tasks: 360, deliverables: 380 } });
    const canon = validateAndCanonicaliseConceptionConfig(json);
    const parsed = JSON.parse(canon);
    expect(parsed.cardMinWidth).toEqual({ logs: 500, tasks: 360, deliverables: 380 });
  });

  it('lets a global save round-trip the new card widths too', () => {
    const json = JSON.stringify({ cardMinWidth: { logs: 500, tasks: 360, deliverables: 380 } });
    const canon = validateAndCanonicaliseGlobalSettings(json);
    const parsed = JSON.parse(canon);
    expect(parsed.cardMinWidth).toEqual({ logs: 500, tasks: 360, deliverables: 380 });
  });
});

describe('configSchema treeExpansion — every IPC-written key is accepted', () => {
  // The reported bug: `setTreeExpansion` writes `skillsUser` (user-scope
  // Skills pane) but the strict schema only listed knowledge/resources/skills,
  // so once a user expanded a user-scope skill directory every Global
  // Settings save threw `Unrecognized key: "skillsUser"`.
  it('accepts skillsUser alongside the other tree keys', () => {
    const result = globalSettingsSchema.safeParse({
      treeExpansion: { knowledge: ['topics'], resources: [], skills: ['pr'], skillsUser: ['git'] },
    });
    expect(result.success).toBe(true);
  });

  it('lets a global save round-trip a skillsUser expansion (the reported failure)', () => {
    const json = JSON.stringify({ treeExpansion: { skillsUser: ['git', ''] } });
    const canon = validateAndCanonicaliseGlobalSettings(json);
    expect(JSON.parse(canon).treeExpansion.skillsUser).toEqual(['git', '']);
  });

  it('still rejects an unknown treeExpansion key (typo guard intact)', () => {
    expect(globalSettingsSchema.safeParse({ treeExpansion: { skillsUsers: [] } }).success).toBe(
      false,
    );
  });
});

describe('every settings key the IPC layer can write survives the canonicaliser', () => {
  // Class fix for the skillsUser bug: build a settings object exercising every
  // setter-reachable key and assert the global canonicaliser accepts it. A new
  // IPC setter whose key (or sub-key) is missing from the schema fails here
  // instead of bricking every subsequent Global Settings save in production.
  it('round-trips a settings object covering every IPC setter', () => {
    const everySetterKey = {
      // pickConceptionPath / openConception / removeRecentConceptionPath
      lastConceptionPath: '/home/me/src/conception',
      recentConceptionPaths: ['/home/me/src/conception', '/home/me/src/other'],
      // setTheme
      theme: 'dark',
      // setLayout
      layout: {
        projects: true,
        leftView: 'deliverables',
        working: 'logs',
        terminal: true,
        projectsWidth: 320,
      },
      // setWelcomeDismissed
      welcome: { dismissed: true },
      // setCardMinWidth — every pane key
      cardMinWidth: Object.fromEntries(CARD_MIN_WIDTH_KEYS.map((key) => [key, 500])),
      // setTreeExpansion — every tree key
      treeExpansion: {
        knowledge: ['topics'],
        resources: ['renders'],
        skills: ['pr'],
        skillsUser: ['git'],
      },
      // setSelectedBranches / setBranchFilterStickyAll
      selectedBranches: ['main', 'feature-x'],
      branchFilterStickyAll: false,
      // setSkillsActiveScope
      skillsActiveScope: 'user',
      // termSetPrefs
      terminal: {
        shell: '/bin/zsh',
        shortcut: 'Ctrl+T',
        screenshot_dir: '/home/me/Pictures',
        xterm: { font_size: 13, cursor_blink: true },
        logging: { enabled: true, retentionDays: 14, maxDirMb: 500, scrollback: 10000 },
      },
      // writeTaskConfig (Tasks editor) — every TaskConfigEntry field
      taskConfig: {
        'sample-task': {
          schedule: '5m',
          timeout: '1m',
          excludeFromLogs: true,
          runMode: 'oneshot',
          gateOnUpdatedTabs: true,
        },
      },
    };
    expect(() =>
      validateAndCanonicaliseGlobalSettings(JSON.stringify(everySetterKey)),
    ).not.toThrow();
  });
});

describe('config field-naming convention (D6-2 — frozen)', () => {
  // The config surface mixes snake_case (repo / terminal-shell vocabulary) and
  // camelCase (app/UI prefs) for historical reasons; existing keys are NOT
  // renamed (a rename is a breaking settings migration). This guard freezes
  // the rule for NEW keys: every top-level key must be pure snake_case or pure
  // camelCase — never kebab-case, PascalCase, or SCREAMING_SNAKE. The
  // convention itself is documented in config-schema.ts's header docblock.
  const SNAKE_OR_CAMEL = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$|^[a-z][a-zA-Z0-9]*$/;

  // `$`-prefixed keys are a reserved meta-key namespace (e.g. the
  // self-documenting `$schema_doc` hint), not user config fields, so they sit
  // outside the snake/camel rule.
  function topLevelKeys(schema: { shape: Record<string, unknown> }): string[] {
    return Object.keys(schema.shape).filter((key) => !key.startsWith('$'));
  }

  it('every top-level conceptionConfig key is snake_case or camelCase', () => {
    for (const key of topLevelKeys(configSchema)) {
      expect(SNAKE_OR_CAMEL.test(key), `key "${key}" must be snake_case or camelCase`).toBe(true);
    }
  });

  it('every top-level globalSettings key is snake_case or camelCase', () => {
    for (const key of topLevelKeys(globalSettingsSchema)) {
      expect(SNAKE_OR_CAMEL.test(key), `key "${key}" must be snake_case or camelCase`).toBe(true);
    }
  });

  it('the guard regex rejects the styles the convention forbids', () => {
    // Sanity-check the matcher so a permissive regex can't silently pass.
    expect(SNAKE_OR_CAMEL.test('pinned_branch')).toBe(true);
    expect(SNAKE_OR_CAMEL.test('cardMinWidth')).toBe(true);
    expect(SNAKE_OR_CAMEL.test('kebab-case')).toBe(false);
    expect(SNAKE_OR_CAMEL.test('PascalCase')).toBe(false);
    expect(SNAKE_OR_CAMEL.test('SCREAMING_SNAKE')).toBe(false);
    expect(SNAKE_OR_CAMEL.test('mixed_Snake')).toBe(false);
  });
});
