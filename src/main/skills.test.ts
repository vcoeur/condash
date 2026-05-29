import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSkillsTree, readSkillsTreeForScope } from './skills';

let tmp: string;
let userHome: string;

const USER_ENV_KEYS = ['CONDASH_USER_SKILLS_ROOT', 'CONDASH_USER_AGENTS_MD'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-skills-'));
  userHome = mkdtempSync(join(tmpdir(), 'condash-user-'));
  savedEnv = {};
  for (const key of USER_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
  for (const key of USER_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setupConceptionSkills(): void {
  mkdirSync(join(tmp, '.agents', 'skills', 'projects', 'subdir'), { recursive: true });
  writeFileSync(
    join(tmp, '.agents', 'skills', 'projects', 'SKILL.md'),
    '# Projects skill\n\nLead paragraph.\n',
  );
  writeFileSync(
    join(tmp, '.agents', 'skills', 'projects', 'create.md'),
    '# Create\n\nCreate notes.\n',
  );
  writeFileSync(join(tmp, '.agents', 'skills', 'projects', 'subdir', 'deep.md'), '# Deep helper\n');
  writeFileSync(join(tmp, '.agents', 'skills', 'projects', 'image.png'), 'binary');
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('readSkillsTree (conception scope, default)', () => {
  it('returns null when neither the skills directory nor AGENTS.md exists', async () => {
    const tree = await readSkillsTree(tmp);
    expect(tree).toBeNull();
  });

  it('only surfaces .md files and recurses', async () => {
    setupConceptionSkills();
    const tree = (await readSkillsTree(tmp))!;
    const projects = tree.children?.find((c) => c.name === 'projects');
    expect(projects?.name).toBe('projects');
    const fileNames = (projects?.children ?? []).map((c) => c.name).sort();
    // 'image.png' must not appear.
    expect(fileNames).toEqual(['SKILL.md', 'create.md', 'subdir']);
    const subdir = (projects?.children ?? []).find((c) => c.name === 'subdir');
    expect(subdir?.children?.[0]?.name).toBe('deep.md');
  });

  it('parses title + summary for SKILL.md', async () => {
    setupConceptionSkills();
    const tree = (await readSkillsTree(tmp))!;
    const projects = tree.children?.find((c) => c.name === 'projects');
    const skill = projects?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.title).toBe('Projects skill');
    expect(skill?.summary).toContain('Lead paragraph');
  });

  it('does not stamp files when no manifest is present', async () => {
    setupConceptionSkills();
    const tree = (await readSkillsTree(tmp))!;
    const projects = tree.children?.find((c) => c.name === 'projects');
    const skill = projects?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped).toBeUndefined();
  });

  it('stamps tracked files and detects divergence', async () => {
    setupConceptionSkills();
    const onDiskBody = '# Projects skill\n\nLead paragraph.\n';
    const skillDiskSha = sha(onDiskBody);
    const manifest = {
      version: 3,
      skills: {
        projects: {
          source: {
            'SKILL.md': { sha256: skillDiskSha, shippedVersion: '1.2.3' },
            'create.md': { sha256: 'deadbeef', shippedVersion: '1.2.3' },
          },
        },
      },
    };
    writeFileSync(join(tmp, '.agents', '.condash-skills.json'), JSON.stringify(manifest, null, 2));
    const tree = (await readSkillsTree(tmp))!;
    const projects = tree.children?.find((c) => c.name === 'projects');
    const skill = projects?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped?.diverged).toBe(false);
    expect(skill?.shipped?.shippedVersion).toBe('1.2.3');
    const create = projects?.children?.find((c) => c.name === 'create.md');
    expect(create?.shipped?.diverged).toBe(true);
  });

  it('pins AGENTS.md at the top of the tree as a read-only callout', async () => {
    setupConceptionSkills();
    writeFileSync(join(tmp, 'AGENTS.md'), '# Conception AGENTS\n\nProject brief.\n');
    const tree = (await readSkillsTree(tmp))!;
    expect(tree.children?.[0]?.badge).toBe('AGENTS');
    expect(tree.children?.[0]?.title).toBe('Conception AGENTS');
  });

  it('returns a synthetic root with just AGENTS.md when the skills dir is missing', async () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Conception AGENTS\n');
    const tree = (await readSkillsTree(tmp))!;
    expect(tree.children?.length).toBe(1);
    expect(tree.children?.[0]?.badge).toBe('AGENTS');
  });
});

describe('readSkillsTreeForScope (user scope)', () => {
  it('reads agedum sources from CONDASH_USER_SKILLS_ROOT + CONDASH_USER_AGENTS_MD', async () => {
    const userSkills = join(userHome, '.agents', 'skills');
    mkdirSync(join(userSkills, 'mything'), { recursive: true });
    writeFileSync(join(userSkills, 'mything', 'SKILL.md'), '# My thing\n\nUser skill.\n');
    const userAgents = join(userHome, '.config', 'agents', 'AGENTS.md');
    mkdirSync(join(userHome, '.config', 'agents'), { recursive: true });
    writeFileSync(userAgents, '# User AGENTS\n\nGlobal brief.\n');
    process.env.CONDASH_USER_SKILLS_ROOT = userSkills;
    process.env.CONDASH_USER_AGENTS_MD = userAgents;

    const tree = (await readSkillsTreeForScope('user', tmp))!;
    // AGENTS.md pinned first; mything skill follows.
    expect(tree.children?.[0]?.badge).toBe('AGENTS');
    expect(tree.children?.[0]?.title).toBe('User AGENTS');
    const skill = tree.children?.find((c) => c.name === 'mything');
    expect(skill?.kind).toBe('directory');
  });

  it('returns null when neither user skills nor AGENTS.md exists', async () => {
    process.env.CONDASH_USER_SKILLS_ROOT = join(userHome, 'no-skills');
    process.env.CONDASH_USER_AGENTS_MD = join(userHome, 'no-agents.md');
    const tree = await readSkillsTreeForScope('user', tmp);
    expect(tree).toBeNull();
  });
});
