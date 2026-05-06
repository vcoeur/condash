import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSkillsTree } from './skills';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-skills-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setupSkills(): void {
  mkdirSync(join(tmp, '.claude'));
  mkdirSync(join(tmp, '.claude', 'skills'));
  mkdirSync(join(tmp, '.claude', 'skills', 'projects'));
  mkdirSync(join(tmp, '.claude', 'skills', 'projects', 'subdir'));
  writeFileSync(
    join(tmp, '.claude', 'skills', 'projects', 'SKILL.md'),
    '# Projects skill\n\nLead paragraph.\n',
  );
  writeFileSync(
    join(tmp, '.claude', 'skills', 'projects', 'create.md'),
    '# Create\n\nCreate notes.\n',
  );
  writeFileSync(
    join(tmp, '.claude', 'skills', 'projects', 'subdir', 'deep.md'),
    '# Deep helper\n',
  );
  writeFileSync(join(tmp, '.claude', 'skills', 'projects', 'image.png'), 'binary');
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('readSkillsTree', () => {
  it('returns null when the directory is missing', async () => {
    const tree = await readSkillsTree(tmp, '.claude/skills');
    expect(tree).toBeNull();
  });

  it('only surfaces .md files and recurses', async () => {
    setupSkills();
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const projects = tree.children?.[0];
    expect(projects?.name).toBe('projects');
    const fileNames = (projects?.children ?? []).map((c) => c.name).sort();
    // 'image.png' must not appear.
    expect(fileNames).toEqual(['SKILL.md', 'create.md', 'subdir']);
    const subdir = (projects?.children ?? []).find((c) => c.name === 'subdir');
    expect(subdir?.children?.[0]?.name).toBe('deep.md');
  });

  it('parses title + summary for SKILL.md', async () => {
    setupSkills();
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const skill = tree.children?.[0]?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.title).toBe('Projects skill');
    expect(skill?.summary).toContain('Lead paragraph');
  });

  it('does not stamp files when no manifest is present', async () => {
    setupSkills();
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const skill = tree.children?.[0]?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped).toBeUndefined();
  });

  it('stamps tracked files and detects divergence', async () => {
    setupSkills();
    const onDiskBody = '# Projects skill\n\nLead paragraph.\n';
    const skillDiskSha = sha(onDiskBody);
    const manifest = {
      version: 1,
      skills: {
        projects: {
          files: {
            'SKILL.md': { sha256: skillDiskSha, shippedVersion: '2.10.15' },
            'create.md': { sha256: 'deadbeef', shippedVersion: '2.10.15' },
          },
        },
      },
    };
    writeFileSync(
      join(tmp, '.claude', 'skills', '.condash-skills.json'),
      JSON.stringify(manifest),
    );

    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const projects = tree.children?.[0];
    const skill = projects?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped).toBeDefined();
    expect(skill?.shipped?.diverged).toBe(false);
    expect(skill?.shipped?.shippedVersion).toBe('2.10.15');

    const create = projects?.children?.find((c) => c.name === 'create.md');
    expect(create?.shipped?.diverged).toBe(true);
  });

  it('degrades silently with a malformed manifest', async () => {
    setupSkills();
    writeFileSync(join(tmp, '.claude', 'skills', '.condash-skills.json'), '{not-json');
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const skill = tree.children?.[0]?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped).toBeUndefined();
  });
});
