import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProject } from './project';
import type { OutputContext } from '../output';

let dest: string;

beforeEach(async () => {
  dest = await fs.mkdtemp(join(tmpdir(), 'project-build-'));
});

afterEach(async () => {
  await fs.rm(dest, { recursive: true, force: true });
});

function ctx(): OutputContext {
  return { json: true, ndjson: false, quiet: true, noColor: true };
}

async function build(): Promise<void> {
  await runProject(
    'build',
    { noun: 'project', verb: 'build', positional: [], flags: { dest } },
    ctx(),
  );
}

describe('condash project build', () => {
  it('compiles AGENTS.md to .claude/CLAUDE.md and .kimi/AGENTS.md', async () => {
    const source = [
      '# AGENTS.md — test',
      '',
      '## General',
      '',
      'Skills at {{ skills_dir }}.',
      '',
      '### Claude',
      '',
      '- Memory at {{ memory_dir }}.',
      '',
      '### Kimi',
      '',
      '- No memory.',
      '',
    ].join('\n');
    await fs.writeFile(join(dest, 'AGENTS.md'), source, 'utf8');
    await build();

    const claude = await fs.readFile(join(dest, '.claude/CLAUDE.md'), 'utf8');
    expect(claude).toContain('Skills at .claude/skills/.');
    expect(claude).toContain('Memory at ~/.claude/projects/');
    expect(claude).not.toContain('No memory.');

    const kimi = await fs.readFile(join(dest, '.kimi/AGENTS.md'), 'utf8');
    expect(kimi).toContain('Skills at .kimi/skills/.');
    expect(kimi).toContain('No memory.');
    expect(kimi).not.toContain('Memory at');
  });

  it('errors with NOT_FOUND when AGENTS.md is missing', async () => {
    await expect(build()).rejects.toThrow(/No AGENTS\.md found/);
  });
});
