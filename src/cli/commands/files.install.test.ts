/**
 * Install tests for the top-level file branch of `condash skills install`
 * (the artist formerly known as `condash templates install`). Verifies the
 * AGENTS.md / .gitignore region-merge pass, the AGENTS.md → per-target
 * compile pass, the legacy CLAUDE.md → AGENTS.md migration, and the v2 → v3
 * manifest namespace rename (`templates` → `files`).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkills } from './skills';
import { MANIFEST_RELPATH, readManifest, sha256 } from './install-shared';
import { extractRegion } from './regions';
import type { OutputContext } from '../output';

const TEMPLATE_ROOT = resolve(__dirname, '..', '..', '..', 'conception-template');

let dest: string;

beforeEach(async () => {
  dest = await fs.mkdtemp(join(tmpdir(), 'files-install-'));
});

afterEach(async () => {
  await fs.rm(dest, { recursive: true, force: true });
});

function ctx(): OutputContext {
  return { json: true, ndjson: false, quiet: true, noColor: true };
}

async function install(positional: string[] = []): Promise<void> {
  process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
  await runSkills(
    'install',
    { noun: 'skills', verb: 'install', positional, flags: { dest } },
    ctx(),
  );
}

describe('condash skills install — top-level files', () => {
  it('writes AGENTS.md and compiles to .claude/CLAUDE.md + .kimi/AGENTS.md', async () => {
    await install(['AGENTS.md']);

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

  it('migrates a legacy CLAUDE.md + v1 templates manifest to AGENTS.md', async () => {
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

    await install(['AGENTS.md']);

    // CLAUDE.md is gone; AGENTS.md is present.
    await expect(fs.access(join(dest, 'CLAUDE.md'))).rejects.toThrow();
    const agents = await fs.readFile(join(dest, 'AGENTS.md'), 'utf8');
    // The user's `## Specifics` survived.
    expect(agents).toContain('My custom specifics.');
    // The `## General` region was refreshed to the shipped content.
    expect(agents).toContain('Pointers');

    // Manifest entry migrated to AGENTS.md key, under the new `files` namespace.
    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    expect(manifest!.files!['AGENTS.md']).toBeTruthy();
    expect(manifest!.files!['CLAUDE.md']).toBeUndefined();

    // Compiled outputs landed.
    await fs.access(join(dest, '.claude/CLAUDE.md'));
    await fs.access(join(dest, '.kimi/AGENTS.md'));
  });

  it('records AGENTS.md under the v3 files namespace (not templates)', async () => {
    await install(['AGENTS.md']);
    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    expect(manifest!.files!['AGENTS.md']).toBeTruthy();
    expect((manifest as unknown as { templates?: unknown }).templates).toBeUndefined();
  });

  it('migrates a v2 manifest with `templates` to v3 `files` on first install', async () => {
    // Plant a v2 manifest tracking CLAUDE.md (an entry condash 3.x no longer ships).
    const manifestPath = join(dest, '.claude/skills', MANIFEST_RELPATH);
    await fs.mkdir(join(dest, '.claude/skills'), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 2,
          skills: {},
          templates: {
            'CLAUDE.md': { region: 'General', sha256: 'x'.repeat(64), shippedVersion: '2.26.0' },
          },
        },
        null,
        2,
      ),
    );

    await install(['AGENTS.md']);

    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    // The stale CLAUDE.md entry survives the migration (it's still tracked in
    // `files` — only --prune removes it).
    expect(manifest!.files!['CLAUDE.md']).toBeTruthy();
    expect(manifest!.files!['AGENTS.md']).toBeTruthy();
  });

  it('--prune drops manifest entries whose shipped source no longer exists', async () => {
    // Plant a v2 manifest tracking CLAUDE.md (no longer shipped).
    const manifestPath = join(dest, '.claude/skills', MANIFEST_RELPATH);
    await fs.mkdir(join(dest, '.claude/skills'), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 2,
          skills: {},
          templates: {
            'CLAUDE.md': { region: 'General', sha256: 'x'.repeat(64), shippedVersion: '2.26.0' },
          },
        },
        null,
        2,
      ),
    );

    // Install with --prune.
    process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
    await runSkills(
      'install',
      { noun: 'skills', verb: 'install', positional: [], flags: { dest, prune: true } },
      ctx(),
    );

    const manifest = await readManifest(dest);
    expect(manifest!.files!['CLAUDE.md']).toBeUndefined();
  });
});
