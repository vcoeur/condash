import { describe, expect, it } from 'vitest';
import { applyLauncherEdit, buildSavePayload, compactRepos } from './data';
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

describe('applyLauncherEdit', () => {
  it('does not create an entry when only the title is set (command empty)', () => {
    // Reproduces the v2.28.0 incident: typing into Title without a Command
    // would persist a `{ symbol, command: '', title }` entry, which `pruneEmpty`
    // strips to `{ symbol, title }` — then the strict launcherSchema rejects
    // it with `expected string, received undefined`.
    expect(applyLauncherEdit(undefined, 'lambda', 'title', 'My title')).toBeUndefined();
  });

  it('creates an entry once the command is filled', () => {
    expect(applyLauncherEdit(undefined, 'lambda', 'command', 'claude')).toEqual([
      { symbol: 'lambda', command: 'claude', title: undefined },
    ]);
  });

  it('attaches a title to an existing command entry', () => {
    const next = applyLauncherEdit(
      [{ symbol: 'lambda', command: 'claude' }],
      'lambda',
      'title',
      'CLD',
    );
    expect(next).toEqual([{ symbol: 'lambda', command: 'claude', title: 'CLD' }]);
  });

  it('drops the entry when its command is cleared, even if title was set', () => {
    const next = applyLauncherEdit(
      [{ symbol: 'lambda', command: 'claude', title: 'CLD' }],
      'lambda',
      'command',
      '',
    );
    expect(next).toBeUndefined();
  });

  it('preserves the other slot when one slot is cleared', () => {
    const next = applyLauncherEdit(
      [
        { symbol: 'lambda', command: 'claude' },
        { symbol: 'mu', command: 'python -m notebook' },
      ],
      'lambda',
      'command',
      '',
    );
    expect(next).toEqual([{ symbol: 'mu', command: 'python -m notebook' }]);
  });

  it('produces a schema-valid payload through buildSavePayload + launcherSchema', () => {
    const launchers = applyLauncherEdit(undefined, 'lambda', 'command', 'claude');
    const payload = buildSavePayload({ terminal: { launchers } });
    const result = conceptionConfigSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('title-only edit yields a payload that the strict schema accepts (no orphan entry)', () => {
    const launchers = applyLauncherEdit(undefined, 'lambda', 'title', 'CLD');
    const payload = buildSavePayload({ terminal: { launchers } });
    const result = conceptionConfigSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
