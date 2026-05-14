import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTemplates, extractRegion } from './templates';
import { MANIFEST_RELPATH, readManifest, sha256 } from './install-shared';
import type { OutputContext } from '../output';

const TEMPLATE_ROOT = resolve(__dirname, '..', '..', '..', 'conception-template');

let dest: string;

beforeEach(async () => {
  dest = await fs.mkdtemp(join(tmpdir(), 'templates-install-'));
});

afterEach(async () => {
  await fs.rm(dest, { recursive: true, force: true });
});

function ctx(): OutputContext {
  return { json: true, ndjson: false, quiet: true, noColor: true };
}

async function install(): Promise<void> {
  process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
  await runTemplates(
    'install',
    { noun: 'templates', verb: 'install', positional: [], flags: { dest } },
    ctx(),
  );
}

describe('condash templates install (AGENTS.md compile)', () => {
  it('writes AGENTS.md and compiles to .claude/CLAUDE.md + .kimi/AGENTS.md', async () => {
    await install();

    const agents = await fs.readFile(join(dest, 'AGENTS.md'), 'utf8');
    expect(agents).toMatch(/^# AGENTS\.md — conception/);

    const claude = await fs.readFile(join(dest, '.claude/CLAUDE.md'), 'utf8');
    // Variable substitution: skills_dir → .claude/skills/
    expect(claude).toContain('.claude/skills/projects/SKILL.md');
    // ### Kimi sections stripped, ### Claude sections kept.
    expect(claude).toContain('Auto-memory opt-out');

    const kimi = await fs.readFile(join(dest, '.kimi/AGENTS.md'), 'utf8');
    expect(kimi).toContain('.kimi/skills/projects/SKILL.md');
    expect(kimi).not.toContain('Auto-memory opt-out');
  });

  it('migrates a legacy CLAUDE.md + manifest to AGENTS.md before installing', async () => {
    // Plant a legacy CLAUDE.md with a `## General` region the user has not edited
    // (its hash matches the manifest) and a `## Specifics` they've customised.
    const legacy = [
      '# CLAUDE.md — conception',
      '',
      '## General',
      '',
      'old shipped general body',
      '',
      '## Specifics',
      '',
      'My custom specifics.',
      '',
    ].join('\n');
    await fs.writeFile(join(dest, 'CLAUDE.md'), legacy, 'utf8');

    // Plant a v1 manifest entry tracking CLAUDE.md's General region SHA.
    const region = extractRegion(legacy, 'General')!;
    const manifestPath = join(dest, '.claude/skills', MANIFEST_RELPATH);
    await fs.mkdir(join(dest, '.claude/skills'), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          skills: {},
          templates: {
            'CLAUDE.md': { region: 'General', sha256: sha256(region), shippedVersion: '2.28.2' },
          },
        },
        null,
        2,
      ),
    );

    await install();

    // CLAUDE.md is gone; AGENTS.md is present.
    await expect(fs.access(join(dest, 'CLAUDE.md'))).rejects.toThrow();
    const agents = await fs.readFile(join(dest, 'AGENTS.md'), 'utf8');
    // The user's `## Specifics` survived.
    expect(agents).toContain('My custom specifics.');
    // The `## General` region was refreshed to the shipped content.
    expect(agents).toContain('Pointers');

    // Manifest entry migrated to AGENTS.md key.
    const manifest = await readManifest(dest);
    expect(manifest!.templates!['AGENTS.md']).toBeTruthy();
    expect(manifest!.templates!['CLAUDE.md']).toBeUndefined();

    // Compiled outputs landed.
    await fs.access(join(dest, '.claude/CLAUDE.md'));
    await fs.access(join(dest, '.kimi/AGENTS.md'));
  });

  it('manifest entry is keyed AGENTS.md (not CLAUDE.md) after install', async () => {
    await install();
    const manifest = await readManifest(dest);
    expect(manifest!.templates!['AGENTS.md']).toBeTruthy();
    expect(manifest!.templates!['CLAUDE.md']).toBeUndefined();
  });
});
