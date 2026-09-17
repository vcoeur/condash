import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLinks } from './links';

let conceptionPath: string;

async function writeFile(relPath: string, content: string): Promise<void> {
  const path = join(conceptionPath, relPath);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

beforeEach(async () => {
  conceptionPath = await fs.mkdtemp(join(tmpdir(), 'condash-links-'));
  await fs.mkdir(join(conceptionPath, 'knowledge'), { recursive: true });
  await fs.mkdir(join(conceptionPath, 'projects'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(conceptionPath, { recursive: true, force: true });
});

describe('checkLinks', () => {
  it('reports missing relative Markdown targets with the source line', async () => {
    await writeFile('knowledge/topic.md', '# Topic\n\n[Gone](missing.md)\n');

    const issues = await checkLinks(conceptionPath);

    expect(issues).toMatchObject([
      {
        check: 'links',
        severity: 'error',
        file: 'knowledge/topic.md',
        line: 3,
        message: 'Link target does not exist: missing.md',
        fix: { action: 'flag_for_user_review', autoFix: false, target: 'missing.md' },
      },
    ]);
  });

  it('URL-decodes a relative path before resolving it', async () => {
    await writeFile('knowledge/with space.md', '# Target\n');
    await writeFile('knowledge/source.md', '[Target](with%20space.md)\n');

    await expect(checkLinks(conceptionPath)).resolves.toEqual([]);
  });

  it('accepts GitHub-style heading anchors, including duplicate suffixes', async () => {
    await writeFile(
      'knowledge/target.md',
      '# Repeated heading\n\n## Repeated heading\n\n### A heading!\n',
    );
    await writeFile(
      'knowledge/source.md',
      '[First](target.md#repeated-heading)\n[Second](target.md#repeated-heading-1)\n[Plain](target.md#a-heading)\n',
    );

    await expect(checkLinks(conceptionPath)).resolves.toEqual([]);
  });

  it('reports dead same-file and cross-file anchors', async () => {
    await writeFile('knowledge/target.md', '# Present\n');
    await writeFile(
      'knowledge/source.md',
      '# Source\n\n[Local](#missing)\n[Other](target.md#also-missing)\n',
    );

    const issues = await checkLinks(conceptionPath);

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.line)).toEqual([3, 4]);
    expect(issues.map((issue) => issue.message)).toEqual([
      'Anchor #missing does not exist in knowledge/source.md',
      'Anchor #also-missing does not exist in knowledge/target.md',
    ]);
  });

  it('accepts explicit HTML id and legacy name anchors', async () => {
    await writeFile('knowledge/target.md', '<a id="stable-id"></a>\n<a name="legacy"></a>\n');
    await writeFile(
      'knowledge/source.md',
      '[Stable](target.md#stable-id)\n[Legacy](target.md#legacy)\n',
    );

    await expect(checkLinks(conceptionPath)).resolves.toEqual([]);
  });

  it('ignores fenced and inline-code link-shaped examples', async () => {
    await writeFile(
      'knowledge/source.md',
      [
        '```markdown',
        '[Fenced](missing.md)',
        '```',
        '',
        'Use `[Inline](also-missing.md)` as an example.',
        '',
      ].join('\n'),
    );

    await expect(checkLinks(conceptionPath)).resolves.toEqual([]);
  });

  it('ignores external schemes and protocol-relative links', async () => {
    await writeFile(
      'knowledge/source.md',
      '[Web](https://example.com/missing.md) [Mail](mailto:alice@example.com) [Other](custom:thing) [CDN](//example.com/path)\n',
    );

    await expect(checkLinks(conceptionPath)).resolves.toEqual([]);
  });

  it('resolves bare Transferred targets from the conception root', async () => {
    await writeFile('knowledge/topics/promoted.md', '# Promoted\n');
    await writeFile(
      'projects/2026-09/2026-09-17-project/notes/01-work.md',
      '**Transferred:** 2026-09-17 → `knowledge/topics/promoted.md`\n',
    );

    await expect(checkLinks(conceptionPath)).resolves.toEqual([]);
  });

  it('parses a Markdown-link-form Transferred marker before resolving its target', async () => {
    await writeFile('knowledge/topics/promoted.md', '# Promoted\n');
    await writeFile(
      'projects/2026-09/2026-09-17-project/notes/01-work.md',
      '**Transferred:** 2026-09-17 → [Promoted](../../../../knowledge/topics/promoted.md)\n',
    );

    await expect(checkLinks(conceptionPath)).resolves.toEqual([]);
  });

  it('reports missing Transferred targets in both supported forms', async () => {
    await writeFile(
      'projects/2026-09/2026-09-17-project/notes/01-work.md',
      [
        '**Transferred:** 2026-09-17 → `knowledge/topics/missing.md`',
        '**Transferred:** 2026-09-17 → [Missing](../../../../knowledge/topics/also-missing.md)',
        '',
      ].join('\n'),
    );

    const issues = await checkLinks(conceptionPath);

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.message)).toEqual([
      'Transferred marker target does not exist: knowledge/topics/missing.md',
      'Transferred marker target does not exist: ../../../../knowledge/topics/also-missing.md',
    ]);
  });
});
