import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addStep } from './mutate';

describe('addStep', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'addstep-'));
    path = join(dir, 'README.md');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('appends after existing steps', async () => {
    await fs.writeFile(
      path,
      ['# T', '', '## Steps', '', '- [ ] one', '', '## Timeline', ''].join('\n'),
      'utf8',
    );
    await addStep(path, 'two');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('- [ ] one\n- [ ] two');
  });

  it('inserts when section has no steps yet (only blank lines)', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '## Timeline', ''].join('\n'), 'utf8');
    await addStep(path, 'first');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toMatch(/## Steps[\s\S]*- \[ \] first[\s\S]*## Timeline/);
  });

  it('inserts when ## Steps is the last section', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', ''].join('\n'), 'utf8');
    await addStep(path, 'only');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('- [ ] only');
  });

  it('appends a fresh ## Steps section when missing', async () => {
    await fs.writeFile(path, ['# T', '', '## Goal', '', 'x', ''].join('\n'), 'utf8');
    await addStep(path, 'first');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toMatch(/## Goal[\s\S]*## Steps\s+\n- \[ \] first/);
  });

  it('leaves a blank line separator when section was previously empty', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '## Timeline', ''].join('\n'), 'utf8');
    await addStep(path, 'first');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('## Steps\n\n- [ ] first\n\n## Timeline');
  });
});
