import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSlug } from './slug-resolver';
import { makeTmpConception, rmConception, writeProjectReadme } from './commands/test-helpers';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

describe('resolveSlug', () => {
  it('resolves a unique short slug and returns a POSIX relPath (C5)', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const candidate = await resolveSlug(conceptionPath, 'alpha');
    expect(candidate.slug).toBe('2026-05-01-alpha');
    expect(candidate.relPath).toBe('projects/2026-05/2026-05-01-alpha');
    expect(candidate.relPath).not.toContain('\\');
    expect(candidate.itemDir.startsWith(conceptionPath)).toBe(true);
  });

  it('resolves a month-qualified slug with a POSIX relPath', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const candidate = await resolveSlug(conceptionPath, '2026-05/2026-05-01-alpha');
    expect(candidate.relPath).toBe('projects/2026-05/2026-05-01-alpha');
  });
});
