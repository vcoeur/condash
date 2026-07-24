import { describe, expect, it } from 'vitest';
import {
  addActionTemplate,
  buildSavePayload,
  compactRepos,
  mergeRawConfig,
  moveActionTemplate,
  patchActionTemplate,
  removeActionTemplate,
  usableActionTemplates,
} from './data';
import { conceptionConfigSchema, globalSettingsSchema } from '../../main/config-schema';

describe('buildSavePayload — repositories', () => {
  it('keeps a freshly-added blank repo as { name: "" } so the schema accepts it', () => {
    const payload = buildSavePayload({
      repositories: [{ name: 'condash', label: 'Condash' }, { name: '' }],
    });
    expect(payload.repositories).toEqual([{ name: 'condash', label: 'Condash' }, { name: '' }]);
    const result = conceptionConfigSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('still compacts a name-only entry to a bare string', () => {
    const payload = buildSavePayload({
      repositories: [{ name: 'PaintingManager' }],
    });
    expect(payload.repositories).toEqual(['PaintingManager']);
  });

  it('drops empty-string optional fields from object-shaped entries', () => {
    const payload = buildSavePayload({
      repositories: [{ name: 'foo', label: 'Foo', force_stop: '' }],
    });
    expect(payload.repositories).toEqual([{ name: 'foo', label: 'Foo' }]);
  });

  it('preserves blank-name placeholder entries inside submodules', () => {
    const payload = buildSavePayload({
      repositories: [{ name: 'parent', submodules: [{ name: '' }] }],
    });
    expect(payload.repositories).toEqual([{ name: 'parent', submodules: [{ name: '' }] }]);
  });

  it('still strips empty leaves outside the repositories array', () => {
    const payload = buildSavePayload({
      workspace_path: '/tmp',
      open_with: { main_ide: { label: '', command: '' } } as never,
    });
    expect(payload.open_with).toBeUndefined();
  });
});

describe('buildSavePayload — agents', () => {
  it('round-trips a fully-specified agent and is schema-valid', () => {
    const payload = buildSavePayload({
      agents: [{ id: 'claude-kimi', label: 'Claude · Kimi', command: 'claude-kimi' }],
    });
    expect(payload.agents).toEqual([
      { id: 'claude-kimi', label: 'Claude · Kimi', command: 'claude-kimi' },
    ]);
    expect(globalSettingsSchema.safeParse(payload).success).toBe(true);
  });

  it('keeps a freshly-added blank agent row so the schema still accepts it', () => {
    // pruneEmpty would collapse { id:'', label:'', command:'' } to {} and drop
    // the row; compactAgents preserves it so the user can fill it in post-reload.
    const payload = buildSavePayload({
      agents: [
        { id: 'claude', label: 'Claude', command: 'claude' },
        { id: '', label: '', command: '' },
      ],
    });
    expect(payload.agents).toEqual([
      { id: 'claude', label: 'Claude', command: 'claude' },
      { id: '', label: '', command: '' },
    ]);
    expect(globalSettingsSchema.safeParse(payload).success).toBe(true);
  });

  it('preserves favorite + promptFlags through Save (regression: the toggles were stripped)', () => {
    const payload = buildSavePayload({
      agents: [
        {
          id: 'claude',
          label: 'Claude',
          command: 'agedum claude',
          favorite: true,
          promptFlags: true,
        },
      ],
    });
    expect(payload.agents).toEqual([
      {
        id: 'claude',
        label: 'Claude',
        command: 'agedum claude',
        favorite: true,
        promptFlags: true,
      },
    ]);
    expect(globalSettingsSchema.safeParse(payload).success).toBe(true);
  });

  it('omits favorite + promptFlags when not set rather than writing false', () => {
    const payload = buildSavePayload({
      agents: [
        { id: 'kimi', label: 'Kimi', command: 'agedum kimi', favorite: false, promptFlags: false },
      ],
    });
    expect(payload.agents).toEqual([{ id: 'kimi', label: 'Kimi', command: 'agedum kimi' }]);
  });
});

describe('buildSavePayload — long_lived_branches', () => {
  it('strips empty-string entries and keeps non-empty ones', () => {
    const payload = buildSavePayload({ long_lived_branches: ['main', '', '  ', 'release/*'] });
    expect(payload.long_lived_branches).toEqual(['main', 'release/*']);
    expect(conceptionConfigSchema.safeParse(payload).success).toBe(true);
  });

  it('omits the key when every entry is blank', () => {
    const payload = buildSavePayload({ long_lived_branches: ['', '  '] });
    expect(payload.long_lived_branches).toBeUndefined();
  });

  it('omits the key when the list is undefined', () => {
    const payload = buildSavePayload({});
    expect(payload.long_lived_branches).toBeUndefined();
  });
});

describe('compactRepos — invariants', () => {
  it('round-trips a blank-name entry without dropping the row', () => {
    expect(compactRepos([{ name: '' }])).toEqual([{ name: '' }]);
  });

  it('compacts named-only entries to bare strings', () => {
    expect(compactRepos([{ name: 'foo' }])).toEqual(['foo']);
  });

  it('keeps the object form when extras are present', () => {
    expect(compactRepos([{ name: 'foo', label: 'Foo' }])).toEqual([{ name: 'foo', label: 'Foo' }]);
  });

  it('drops empty submodules arrays', () => {
    expect(compactRepos([{ name: 'foo', submodules: [] }])).toEqual(['foo']);
  });

  it('drops `path` when identical to `name`', () => {
    expect(compactRepos([{ name: 'foo', path: 'foo' }])).toEqual(['foo']);
  });

  it('drops an empty `path` field', () => {
    expect(compactRepos([{ name: 'foo', path: '' }])).toEqual(['foo']);
  });

  it('keeps `path` when it differs from `name`', () => {
    expect(compactRepos([{ name: 'display', path: '/mnt/elsewhere' }])).toEqual([
      { name: 'display', path: '/mnt/elsewhere' },
    ]);
  });

  it('preserves section markers verbatim, never adding a phantom name field', () => {
    expect(
      compactRepos([
        { section: 'Sites' },
        { name: 'alicepeintures.com' },
        { section: 'Tools' },
        { name: 'condash' },
      ]),
    ).toEqual([{ section: 'Sites' }, 'alicepeintures.com', { section: 'Tools' }, 'condash']);
  });

  it('keeps a compacted sectioned payload schema-valid', () => {
    const payload = buildSavePayload({
      repositories: [
        { section: 'Sites' },
        { name: 'alicepeintures.com', run: 'make dev' },
        { section: 'Tools' },
        { name: 'condash' },
      ],
    });
    const result = conceptionConfigSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe('patchActionTemplate', () => {
  it('keeps a row that has only the label set (template still empty)', () => {
    expect(patchActionTemplate(undefined, 0, { label: 'My label' })).toEqual([
      { label: 'My label', template: '' },
    ]);
  });

  it('keeps a row that has only the template set (label still empty)', () => {
    expect(patchActionTemplate(undefined, 0, { template: 'echo {slug}' })).toEqual([
      { label: '', template: 'echo {slug}' },
    ]);
  });

  it('creates a fully-filled entry once both label and template are set', () => {
    expect(
      patchActionTemplate(undefined, 0, {
        label: 'Claude review',
        template: 'claude "review {slug}"',
      }),
    ).toEqual([{ label: 'Claude review', template: 'claude "review {slug}"' }]);
  });

  it('attaches submit flag to an existing entry', () => {
    const next = patchActionTemplate(
      [{ label: 'Claude review', template: 'claude "review {slug}"' }],
      0,
      { submit: true },
    );
    expect(next).toEqual([
      { label: 'Claude review', template: 'claude "review {slug}"', submit: true },
    ]);
  });

  it('keeps the row when only the label is cleared (template still set)', () => {
    const next = patchActionTemplate(
      [{ label: 'Claude review', template: 'claude "review {slug}"' }],
      0,
      { label: '' },
    );
    expect(next).toEqual([{ label: '', template: 'claude "review {slug}"' }]);
  });

  it('keeps the row when only the template is cleared (label still set)', () => {
    const next = patchActionTemplate(
      [{ label: 'Claude review', template: 'claude "review {slug}"' }],
      0,
      { template: '' },
    );
    expect(next).toEqual([{ label: 'Claude review', template: '' }]);
  });

  it('drops the row when both label and template are blank', () => {
    const next = patchActionTemplate(
      [{ label: 'Claude review', template: 'claude "review {slug}"' }],
      0,
      { label: '', template: '' },
    );
    expect(next).toBeUndefined();
  });

  it('preserves the other entry when one is fully cleared', () => {
    const next = patchActionTemplate(
      [
        { label: 'Claude review', template: 'claude "review {slug}"' },
        { label: 'Kimi summary', template: 'kimi "summarise {shortSlug}"' },
      ],
      0,
      { label: '', template: '' },
    );
    expect(next).toEqual([{ label: 'Kimi summary', template: 'kimi "summarise {shortSlug}"' }]);
  });

  it('produces a schema-valid payload through buildSavePayload + actionTemplateSchema', () => {
    const actions = patchActionTemplate(undefined, 0, {
      label: 'Claude review',
      template: 'claude "review {slug}"',
      submit: true,
    });
    const payload = buildSavePayload({ terminal: { projectActions: actions } });
    const result = globalSettingsSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('round-trips a blank-row action template through buildSavePayload + schema', () => {
    // Regression: "+ Add action" produced
    // `terminal.projectActions.0.label — expected string, received undefined`
    // because pruneEmpty collapsed `{ label: '', template: '' }` into `{}`.
    const payload = buildSavePayload({
      terminal: { projectActions: [{ label: '', template: '' }] },
    });
    expect(payload.terminal).toEqual({ projectActions: [{ label: '', template: '' }] });
    const result = globalSettingsSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe('addActionTemplate', () => {
  it('appends a blank action row', () => {
    expect(addActionTemplate(undefined)).toEqual([{ label: '', template: '' }]);
  });

  it('appends to an existing list', () => {
    expect(
      addActionTemplate([{ label: 'Claude review', template: 'claude "review {slug}"' }]),
    ).toEqual([
      { label: 'Claude review', template: 'claude "review {slug}"' },
      { label: '', template: '' },
    ]);
  });
});

describe('removeActionTemplate', () => {
  it('removes the entry at the given index', () => {
    expect(
      removeActionTemplate(
        [
          { label: 'Claude review', template: 'claude "review {slug}"' },
          { label: 'Kimi summary', template: 'kimi "summarise {shortSlug}"' },
        ],
        0,
      ),
    ).toEqual([{ label: 'Kimi summary', template: 'kimi "summarise {shortSlug}"' }]);
  });

  it('returns undefined when the last entry is removed', () => {
    expect(
      removeActionTemplate([{ label: 'Claude review', template: 'claude "review {slug}"' }], 0),
    ).toBeUndefined();
  });
});

describe('moveActionTemplate', () => {
  it('swaps two entries', () => {
    expect(
      moveActionTemplate(
        [
          { label: 'Claude review', template: 'claude "review {slug}"' },
          { label: 'Kimi summary', template: 'kimi "summarise {shortSlug}"' },
        ],
        0,
        1,
      ),
    ).toEqual([
      { label: 'Kimi summary', template: 'kimi "summarise {shortSlug}"' },
      { label: 'Claude review', template: 'claude "review {slug}"' },
    ]);
  });

  it('refuses to move past the start', () => {
    const list = [{ label: 'Claude review', template: 'claude "review {slug}"' }];
    expect(moveActionTemplate(list, 0, -1)).toBe(list);
  });

  it('refuses to move past the end', () => {
    const list = [{ label: 'Claude review', template: 'claude "review {slug}"' }];
    expect(moveActionTemplate(list, 0, 1)).toBe(list);
  });
});

describe('usableActionTemplates', () => {
  it('keeps fully-filled rows in order', () => {
    const rows = [
      { label: 'Claude', template: 'claude {slug}' },
      { label: 'Kimi', template: 'kimi {slug}' },
    ];
    expect(usableActionTemplates(rows)).toEqual(rows);
  });

  it('drops blank-row placeholders so dropdowns never render empty items', () => {
    expect(
      usableActionTemplates([
        { label: '', template: '' },
        { label: 'Claude', template: 'claude {slug}' },
      ]),
    ).toEqual([{ label: 'Claude', template: 'claude {slug}' }]);
  });

  it('drops half-typed rows where either field is blank', () => {
    expect(
      usableActionTemplates([
        { label: 'Half', template: '' },
        { label: '', template: 'half' },
      ]),
    ).toEqual([]);
  });
});

describe('mergeRawConfig — rebasing a staged draft onto a file that moved', () => {
  it('takes the external value for a key the user never touched', () => {
    const base = { theme: 'dark' as const, workspace_path: '/src' };
    const ours = { theme: 'dark' as const, workspace_path: '/elsewhere' };
    const theirs = { theme: 'console' as const, workspace_path: '/src' };
    expect(mergeRawConfig(base, ours, theirs)).toEqual({
      theme: 'console',
      workspace_path: '/elsewhere',
    });
  });

  it('keeps the staged value when only the user moved a key', () => {
    const base = { theme: 'dark' as const };
    expect(mergeRawConfig(base, { theme: 'mist' as const }, base)).toEqual({ theme: 'mist' });
  });

  it('recurses so sibling sub-keys of one top-level block both survive', () => {
    // The reachable in-modal case: the Perf checkbox writes terminal.perf
    // straight to disk while a staged edit sits in terminal.logging. A
    // top-level-key merge would drop one of them.
    const base = { terminal: { logging: { enabled: false }, perf: { enabled: false } } };
    const ours = { terminal: { logging: { enabled: true }, perf: { enabled: false } } };
    const theirs = { terminal: { logging: { enabled: false }, perf: { enabled: true } } };
    expect(mergeRawConfig(base, ours, theirs)).toEqual({
      terminal: { logging: { enabled: true }, perf: { enabled: true } },
    });
  });

  it('prefers the staged value when both sides moved the same leaf', () => {
    expect(
      mergeRawConfig(
        { theme: 'dark' as const },
        { theme: 'mist' as const },
        {
          theme: 'console' as const,
        },
      ),
    ).toEqual({ theme: 'mist' });
  });

  it('treats an array as a leaf rather than merging it element-wise', () => {
    const base = { pdf_viewer: ['zathura'] };
    const ours = { pdf_viewer: ['evince'] };
    const theirs = { pdf_viewer: ['zathura', 'okular'] };
    expect(mergeRawConfig(base, ours, theirs)).toEqual({ pdf_viewer: ['evince'] });
  });

  it('keeps a key the user deleted deleted, even though disk still carries it', () => {
    const base = { theme: 'dark' as const, workspace_path: '/src' };
    const ours = { theme: 'dark' as const };
    const theirs = { theme: 'dark' as const, workspace_path: '/src' };
    expect(mergeRawConfig(base, ours, theirs)).toEqual({ theme: 'dark' });
  });

  it('adopts a key added on disk that the draft never knew about', () => {
    const base = { theme: 'dark' as const };
    const ours = { theme: 'mist' as const };
    const theirs = { theme: 'dark' as const, worktrees_path: '/wt' };
    expect(mergeRawConfig(base, ours, theirs)).toEqual({ theme: 'mist', worktrees_path: '/wt' });
  });
});
