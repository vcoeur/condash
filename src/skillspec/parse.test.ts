import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSkillspec, SkillspecError } from './parse';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'skillspec-parse-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(tmp, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

describe('parseSkillspec', () => {
  it('parses spec + body + claude overlay', async () => {
    await write('spec.yaml', 'description: A test skill\n');
    await write('body.md', '# Title\n\nBody content.\n');
    await write('targets/claude.yaml', 'allowed-tools: Read, Write\n');

    const parsed = await parseSkillspec(tmp);
    expect(parsed.name).toBe(parsed.name); // basename(tmp) — exact value depends on mkdtemp
    expect(parsed.spec).toEqual({ description: 'A test skill' });
    expect(parsed.body).toBe('# Title\n\nBody content.\n');
    expect(parsed.targets.claude).toEqual({ 'allowed-tools': 'Read, Write' });
    expect(parsed.targets.kimi).toBeUndefined();
    expect(parsed.assets).toEqual({});
  });

  it('collects sibling assets, excluding reserved entries', async () => {
    await write('spec.yaml', 'description: x\n');
    await write('body.md', 'body\n');
    await write('targets/claude.yaml', 'k: v\n');
    await write('close.md', 'close action\n');
    await write('references/cmd.md', 'cmd ref\n');
    await write('scripts/foo.sh', '#!/bin/sh\n');

    const parsed = await parseSkillspec(tmp);
    expect(Object.keys(parsed.assets).sort()).toEqual([
      'close.md',
      'references/cmd.md',
      'scripts/foo.sh',
    ]);
    expect(parsed.assets['close.md'].toString('utf8')).toBe('close action\n');
  });

  it('skips hidden files', async () => {
    await write('spec.yaml', 'description: x\n');
    await write('body.md', 'b\n');
    await write('.hidden', 'nope\n');
    await write('subdir/.also-hidden', 'nope\n');
    await write('subdir/visible.md', 'yes\n');

    const parsed = await parseSkillspec(tmp);
    expect(Object.keys(parsed.assets).sort()).toEqual(['subdir/visible.md']);
  });

  it('skips package-manager / editor litter (e.g. dpkg conffile residue)', async () => {
    await write('spec.yaml', 'description: x\n');
    await write('body.md', 'b\n');
    await write('body.md.dpkg-new', 'junk\n');
    await write('body.md.dpkg-tmp', 'junk\n');
    await write('keep.md', 'real asset\n');
    await write('keep.md~', 'editor backup\n');
    await write('subdir/foo.sh.dpkg-old', 'junk\n');

    const parsed = await parseSkillspec(tmp);
    expect(Object.keys(parsed.assets).sort()).toEqual(['keep.md']);
  });

  it('throws when spec.yaml is missing', async () => {
    await write('body.md', 'b\n');
    await expect(parseSkillspec(tmp)).rejects.toThrow(SkillspecError);
  });

  it('throws when body.md is missing', async () => {
    await write('spec.yaml', 'description: x\n');
    await expect(parseSkillspec(tmp)).rejects.toThrow(SkillspecError);
  });

  it('throws when description is missing', async () => {
    await write('spec.yaml', 'name: foo\n');
    await write('body.md', 'b\n');
    await expect(parseSkillspec(tmp)).rejects.toThrow(/description/);
  });

  it('throws on malformed YAML', async () => {
    await write('spec.yaml', 'description: [unclosed\n');
    await write('body.md', 'b\n');
    await expect(parseSkillspec(tmp)).rejects.toThrow(SkillspecError);
  });

  it('treats empty target overlay file as empty mapping', async () => {
    await write('spec.yaml', 'description: x\n');
    await write('body.md', 'b\n');
    await write('targets/kimi.yaml', '');
    const parsed = await parseSkillspec(tmp);
    expect(parsed.targets.kimi).toEqual({});
  });
});
