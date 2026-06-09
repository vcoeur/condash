import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkIndex } from './index-check';

describe('checkIndex — dangling-link scan', () => {
  let conceptionDir: string;

  beforeEach(async () => {
    conceptionDir = await fs.mkdtemp(join(tmpdir(), 'index-check-'));
    await fs.mkdir(join(conceptionDir, 'knowledge'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(conceptionDir, { recursive: true, force: true });
  });

  it('flags a dangling body-file link with its line number', async () => {
    await fs.writeFile(
      join(conceptionDir, 'knowledge', 'index.md'),
      ['# Knowledge', '', '- [`gone.md`](gone.md) — *missing.*', ''].join('\n'),
      'utf8',
    );
    const issues = await checkIndex(conceptionDir);
    const dangling = issues.filter((i) => i.fix.action === 'remove_index_line');
    expect(dangling).toHaveLength(1);
    expect(dangling[0].line).toBe(3);
    expect(dangling[0].fix.path).toBe('gone.md');
  });

  it('ignores link-shaped text inside fenced code blocks', async () => {
    // A fenced example must never feed the auto-fixable remove_index_line
    // action — an auto-fix would delete a line the user wrote.
    await fs.writeFile(
      join(conceptionDir, 'knowledge', 'index.md'),
      [
        '# Knowledge',
        '',
        '```markdown',
        '- [`fenced-example.md`](fenced-example.md) — *does not exist.*',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );
    const issues = await checkIndex(conceptionDir);
    expect(issues.filter((i) => i.fix.action === 'remove_index_line')).toEqual([]);
  });

  it('does not pair a stray [ with a link on a later line', async () => {
    // The old whole-file regex let `[...]` span lines: a stray bracket
    // followed by a real link produced a false dangling-link hit.
    await fs.writeFile(
      join(conceptionDir, 'knowledge', 'index.md'),
      [
        '# Knowledge',
        '',
        'A stray bracket [ sits here',
        'and a phantom target on the next line (phantom.md) must not pair with it.',
        '',
        '- [`real.md`](real.md) — *exists.*',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(join(conceptionDir, 'knowledge', 'real.md'), '# Real\n', 'utf8');
    const issues = await checkIndex(conceptionDir);
    expect(issues.filter((i) => i.fix.action === 'remove_index_line')).toEqual([]);
  });
});
