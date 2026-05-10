import { describe, expect, it } from 'vitest';
import { buildSavePayload, compactRepos } from './data';
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
});
