import { describe, expect, it } from 'vitest';
import {
  addActionTemplate,
  addLauncher,
  buildSavePayload,
  compactRepos,
  moveActionTemplate,
  moveLauncher,
  patchActionTemplate,
  patchLauncher,
  removeActionTemplate,
  removeLauncher,
} from './data';
import { conceptionConfigSchema } from '../../main/config-schema';

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

describe('patchLauncher', () => {
  it('does not create an entry when only the title is set (command empty)', () => {
    expect(patchLauncher(undefined, 0, { title: 'My title' })).toBeUndefined();
  });

  it('creates an entry once the command is filled', () => {
    expect(patchLauncher(undefined, 0, { label: 'Claude', command: 'claude' })).toEqual([
      { label: 'Claude', command: 'claude' },
    ]);
  });

  it('attaches a title to an existing command entry', () => {
    const next = patchLauncher([{ label: 'λ', command: 'claude' }], 0, { title: 'CLD' });
    expect(next).toEqual([{ label: 'λ', command: 'claude', title: 'CLD' }]);
  });

  it('drops the entry when its command is cleared, even if title was set', () => {
    const next = patchLauncher([{ label: 'λ', command: 'claude', title: 'CLD' }], 0, {
      command: '',
    });
    expect(next).toBeUndefined();
  });

  it('preserves the other entry when one is cleared', () => {
    const next = patchLauncher(
      [
        { label: 'λ', command: 'claude' },
        { label: 'μ', command: 'python -m notebook' },
      ],
      0,
      { command: '' },
    );
    expect(next).toEqual([{ label: 'μ', command: 'python -m notebook' }]);
  });

  it('produces a schema-valid payload through buildSavePayload + launcherSchema', () => {
    const launchers = patchLauncher(undefined, 0, { label: 'λ', command: 'claude' });
    const payload = buildSavePayload({ terminal: { launchers } });
    const result = conceptionConfigSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe('addLauncher', () => {
  it('appends a blank launcher row', () => {
    expect(addLauncher(undefined)).toEqual([{ label: '', command: '' }]);
  });

  it('appends to an existing list', () => {
    expect(addLauncher([{ label: 'λ', command: 'claude' }])).toEqual([
      { label: 'λ', command: 'claude' },
      { label: '', command: '' },
    ]);
  });
});

describe('removeLauncher', () => {
  it('removes the entry at the given index', () => {
    expect(
      removeLauncher(
        [
          { label: 'λ', command: 'claude' },
          { label: 'μ', command: 'python -m notebook' },
        ],
        0,
      ),
    ).toEqual([{ label: 'μ', command: 'python -m notebook' }]);
  });

  it('returns undefined when the last entry is removed', () => {
    expect(removeLauncher([{ label: 'λ', command: 'claude' }], 0)).toBeUndefined();
  });
});

describe('moveLauncher', () => {
  it('swaps two entries', () => {
    expect(
      moveLauncher(
        [
          { label: 'λ', command: 'claude' },
          { label: 'μ', command: 'python -m notebook' },
        ],
        0,
        1,
      ),
    ).toEqual([
      { label: 'μ', command: 'python -m notebook' },
      { label: 'λ', command: 'claude' },
    ]);
  });

  it('refuses to move past the start', () => {
    const list = [{ label: 'λ', command: 'claude' }];
    expect(moveLauncher(list, 0, -1)).toBe(list);
  });

  it('refuses to move past the end', () => {
    const list = [{ label: 'λ', command: 'claude' }];
    expect(moveLauncher(list, 0, 1)).toBe(list);
  });
});

describe('patchActionTemplate', () => {
  it('does not create an entry when only the label is set (template empty)', () => {
    expect(patchActionTemplate(undefined, 0, { label: 'My label' })).toBeUndefined();
  });

  it('creates an entry once both label and template are filled', () => {
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

  it('drops the entry when its label is cleared', () => {
    const next = patchActionTemplate(
      [{ label: 'Claude review', template: 'claude "review {slug}"' }],
      0,
      { label: '' },
    );
    expect(next).toBeUndefined();
  });

  it('drops the entry when its template is cleared', () => {
    const next = patchActionTemplate(
      [{ label: 'Claude review', template: 'claude "review {slug}"' }],
      0,
      { template: '' },
    );
    expect(next).toBeUndefined();
  });

  it('preserves the other entry when one is cleared', () => {
    const next = patchActionTemplate(
      [
        { label: 'Claude review', template: 'claude "review {slug}"' },
        { label: 'Kimi summary', template: 'kimi "summarise {shortSlug}"' },
      ],
      0,
      { label: '' },
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
    const result = conceptionConfigSchema.safeParse(payload);
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
