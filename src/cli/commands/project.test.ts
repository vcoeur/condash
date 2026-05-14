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
  it('compiles .agents/agents/ to .claude/CLAUDE.md and .kimi/AGENTS.md', async () => {
    const agentsDir = join(dest, '.agents', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });

    const common = [
      '# AGENTS.md — test',
      '',
      '## General',
      '',
      'Skills at {{ skills_dir }}.',
      '',
      '## Specifics',
      '',
    ].join('\n');
    await fs.writeFile(join(agentsDir, 'common.md'), common, 'utf8');

    const claudeFragment = ['### Claude', '', '- Memory at {{ memory_dir }}.', ''].join('\n');
    await fs.writeFile(join(agentsDir, 'claude.md'), claudeFragment, 'utf8');

    const kimiFragment = ['### Kimi', '', '- No memory.', ''].join('\n');
    await fs.writeFile(join(agentsDir, 'kimi.md'), kimiFragment, 'utf8');

    await build();

    const claude = await fs.readFile(join(dest, '.claude/CLAUDE.md'), 'utf8');
    expect(claude).toContain('Skills at .claude/skills/.');
    expect(claude).toContain('Memory at ~/.claude/projects/');
    expect(claude).not.toContain('No memory.');
    // Fragment inserted before ## Specifics
    expect(claude.indexOf('### Claude')).toBeLessThan(claude.indexOf('## Specifics'));

    const kimi = await fs.readFile(join(dest, '.kimi/AGENTS.md'), 'utf8');
    expect(kimi).toContain('Skills at .kimi/skills/.');
    expect(kimi).toContain('No memory.');
    expect(kimi).not.toContain('Memory at ~/.claude/projects/');
    expect(kimi.indexOf('### Kimi')).toBeLessThan(kimi.indexOf('## Specifics'));
  });

  it('errors with NOT_FOUND when .agents/agents/ is missing', async () => {
    await expect(build()).rejects.toThrow(/No agent-config source found/);
  });
});
