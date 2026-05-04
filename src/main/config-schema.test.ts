import { describe, expect, it } from 'vitest';
import { configSchema } from './config-schema';

describe('configSchema repoEntry', () => {
  it('accepts the new env / install / pinned_branch fields', () => {
    const result = configSchema.safeParse({
      repositories: {
        primary: [
          {
            name: 'frontend',
            install: 'npm install',
            pinned_branch: 'main',
            env: ['.env', '.env.local'],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const repo = result.data.repositories?.primary?.[0];
      expect(typeof repo).toBe('object');
      if (repo && typeof repo !== 'string') {
        expect(repo.env).toEqual(['.env', '.env.local']);
        expect(repo.install).toBe('npm install');
        expect(repo.pinned_branch).toBe('main');
      }
    }
  });

  it('rejects an env array containing an empty string', () => {
    const result = configSchema.safeParse({
      repositories: {
        primary: [{ name: 'frontend', env: ['.env', ''] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('still rejects unknown fields under a repo entry', () => {
    const result = configSchema.safeParse({
      repositories: {
        primary: [{ name: 'frontend', not_a_field: 'x' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('still accepts the bare-string repo shape', () => {
    const result = configSchema.safeParse({
      repositories: { primary: ['standalone-repo'] },
    });
    expect(result.success).toBe(true);
  });
});
