/**
 * Install tests for the top-level file branch of `condash skills install`.
 * Verifies the .gitignore region-merge pass, the `.agents/agents/` → per-target
 * compile pass, and the v2 → v3 manifest namespace rename (`templates` → `files`).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkills } from './skills';
import { MANIFEST_RELPATH, readManifest } from './install-shared';
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
  it('compiles .agents/agents/ to .claude/CLAUDE.md + .kimi/AGENTS.md', async () => {
    await install();

    const claude = await fs.readFile(join(dest, '.claude/CLAUDE.md'), 'utf8');
    // Variable substitution: skills_dir → .claude/skills/
    expect(claude).toContain('.claude/skills/projects/SKILL.md');
    // Claude fragment included.
    expect(claude).toContain('Auto-memory opt-out');

    const kimi = await fs.readFile(join(dest, '.kimi/AGENTS.md'), 'utf8');
    expect(kimi).toContain('.kimi/skills/projects/SKILL.md');
    // Claude fragment excluded from Kimi output.
    expect(kimi).not.toContain('Auto-memory opt-out');
  });

  it('writes .gitignore with region replacement', async () => {
    await install(['.gitignore']);

    const gitignore = await fs.readFile(join(dest, '.gitignore'), 'utf8');
    expect(gitignore).toContain('# General');
    expect(gitignore).toContain('# Specifics');
  });

  it('records .gitignore under the v3 files namespace (not templates)', async () => {
    await install(['.gitignore']);
    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    expect(manifest!.files!['.gitignore']).toBeTruthy();
    expect((manifest as unknown as { templates?: unknown }).templates).toBeUndefined();
  });

  it('migrates a v2 manifest with `templates` to v3 `files` on first install', async () => {
    // Plant a v2 manifest tracking .gitignore.
    const manifestPath = join(dest, '.claude/skills', MANIFEST_RELPATH);
    await fs.mkdir(join(dest, '.claude/skills'), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 2,
          skills: {},
          templates: {
            '.gitignore': { region: 'General', sha256: 'x'.repeat(64), shippedVersion: '2.26.0' },
          },
        },
        null,
        2,
      ),
    );

    await install(['.gitignore']);

    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    // The stale entry survives the migration (it's still tracked in
    // `files` — only --prune removes it).
    expect(manifest!.files!['.gitignore']).toBeTruthy();
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
