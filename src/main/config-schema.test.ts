import { describe, expect, it } from 'vitest';
import { configSchema } from './config-schema';

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
