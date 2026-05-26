/**
 * Install tests for the top-level file branch of `condash skills install`:
 * the `.gitignore` region-merge pass, the `AGENTS.md` marker-region writer,
 * verbatim skill placement (no compile), and the v2 → v3 manifest namespace
 * rename (`templates` → `files`).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkills } from './skills';
import { AGENTS_MD_MARKER, SHIPPED_FILES, statusShippedFile } from './files';
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

async function install(
  positional: string[] = [],
  flags: Record<string, unknown> = {},
): Promise<void> {
  process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
  await runSkills(
    'install',
    { noun: 'skills', verb: 'install', positional, flags: { dest, ...flags } },
    ctx(),
  );
}

describe('condash skills install — skill placement (no compile)', () => {
  it('places the skill source layout verbatim under .agents/skills/<name>/', async () => {
    await install();
    const skillMd = await fs.readFile(join(dest, '.agents/skills/projects/SKILL.md'), 'utf8');
    expect(skillMd).toContain('name: projects');
    expect(skillMd).toContain('description:');
    // A task file ships alongside.
    await fs.access(join(dest, '.agents/skills/projects/close.md'));
    // The Claude overlay ships as a sibling, not merged.
    await fs.access(join(dest, '.agents/skills/projects/SKILL.claude.md'));
  });

  it('does not compile skills to per-harness dirs', async () => {
    await install();
    await expect(fs.access(join(dest, '.claude/skills'))).rejects.toThrow();
    await expect(fs.access(join(dest, '.kimi/skills'))).rejects.toThrow();
    await expect(fs.access(join(dest, '.opencode/skills'))).rejects.toThrow();
  });

  it('does not write any compiled agent-config or opencode.json', async () => {
    await install();
    await expect(fs.access(join(dest, '.claude/CLAUDE.md'))).rejects.toThrow();
    await expect(fs.access(join(dest, '.kimi/AGENTS.md'))).rejects.toThrow();
    await expect(fs.access(join(dest, 'opencode.json'))).rejects.toThrow();
  });
});

describe('condash skills install — AGENTS.md marker region', () => {
  it('creates AGENTS.md with the head, marker, and Specifics stub on a fresh install', async () => {
    await install();
    const agents = await fs.readFile(join(dest, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('## General');
    expect(agents).toContain(AGENTS_MD_MARKER);
    expect(agents).toContain('## Specifics');
    // Head sits above the marker; Specifics below it.
    expect(agents.indexOf('## General')).toBeLessThan(agents.indexOf(AGENTS_MD_MARKER));
    expect(agents.indexOf(AGENTS_MD_MARKER)).toBeLessThan(agents.indexOf('## Specifics'));
    // Skill pointers use the agent-neutral source path, not a compiled dir.
    expect(agents).toContain('.agents/skills/projects/SKILL.md');
    expect(agents).not.toContain('{{');
  });

  it('substitutes conception_name + description from condash.json', async () => {
    await fs.writeFile(join(dest, 'condash.json'), JSON.stringify({ description: 'My tree.' }));
    await install();
    const agents = await fs.readFile(join(dest, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(`# AGENTS.md — ${require('node:path').basename(dest)}`);
    expect(agents).toContain('My tree.');
  });

  it('regenerates the head but preserves the user-owned tail; idempotent', async () => {
    await install();
    const path = join(dest, 'AGENTS.md');
    const original = await fs.readFile(path, 'utf8');
    const idx = original.indexOf(AGENTS_MD_MARKER) + AGENTS_MD_MARKER.length;
    const customTail = `\n\n## Specifics\n\nDurable team rule: always run make format.\n`;
    await fs.writeFile(path, original.slice(0, idx) + customTail);

    await install();
    const after = await fs.readFile(path, 'utf8');
    expect(after).toContain('Durable team rule: always run make format.');
    expect(after).toContain('## General'); // head regenerated

    // A second install with no edits is byte-stable.
    const stable = await fs.readFile(path, 'utf8');
    await install();
    expect(await fs.readFile(path, 'utf8')).toBe(stable);
  });

  it('migrates a marker-less legacy AGENTS.md by pushing it below the marker', async () => {
    const path = join(dest, 'AGENTS.md');
    await fs.writeFile(path, '# My hand-written AGENTS.md\n\nSome project rules.\n');
    await install();
    const after = await fs.readFile(path, 'utf8');
    expect(after).toContain(AGENTS_MD_MARKER);
    expect(after).toContain('My hand-written AGENTS.md');
    // The old content is below the marker, not above it.
    expect(after.indexOf(AGENTS_MD_MARKER)).toBeLessThan(after.indexOf('My hand-written'));
  });

  it('`install AGENTS.md` touches only AGENTS.md', async () => {
    await install(['AGENTS.md']);
    await fs.access(join(dest, 'AGENTS.md'));
    await expect(fs.access(join(dest, '.agents/skills/projects/SKILL.md'))).rejects.toThrow();
    await expect(fs.access(join(dest, '.gitignore'))).rejects.toThrow();
  });

  it('a plain skill install does not rewrite AGENTS.md', async () => {
    await install(['pr']);
    await expect(fs.access(join(dest, 'AGENTS.md'))).rejects.toThrow();
  });
});

describe('condash skills install — .gitignore', () => {
  it('writes .gitignore with region replacement', async () => {
    await install(['.gitignore']);
    const gitignore = await fs.readFile(join(dest, '.gitignore'), 'utf8');
    expect(gitignore).toContain('# General');
    expect(gitignore).toContain('# Specifics');
  });

  it('ignores the per-harness rendered artefacts', async () => {
    await install(['.gitignore']);
    const gitignore = await fs.readFile(join(dest, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.claude/skills/');
    expect(gitignore).toContain('.kimi/skills/');
    expect(gitignore).toContain('.opencode/skills/');
    expect(gitignore).toContain('.claude/CLAUDE.md');
    expect(gitignore).toContain('.kimi/AGENTS.md');
    expect(gitignore).toContain('.opencode/AGENTS.md');
  });

  it('records .gitignore under the v3 files namespace (not templates)', async () => {
    await install(['.gitignore']);
    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    expect(manifest!.files!['.gitignore']).toBeTruthy();
    expect((manifest as unknown as { templates?: unknown }).templates).toBeUndefined();
  });

  it('migrates a v2 manifest with `templates` to v3 `files` on first install', async () => {
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
    expect(manifest!.files!['.gitignore']).toBeTruthy();
  });

  it('ships .gitignore under the alias _gitignore (electron-builder filter workaround)', async () => {
    const entry = SHIPPED_FILES.find((f) => f.path === '.gitignore');
    expect(entry?.sourcePath).toBe('_gitignore');
    await fs.access(join(TEMPLATE_ROOT, '_gitignore'));
    await install(['.gitignore']);
    await fs.access(join(dest, '.gitignore'));
  });

  it('status: no row for a user-owned .gitignore (no manifest, no markers)', async () => {
    await fs.writeFile(join(dest, '.gitignore'), 'node_modules\n*.log\n');
    process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
    const file = SHIPPED_FILES.find((f) => f.path === '.gitignore')!;
    const manifest = { version: 3 as const, skills: {}, files: {} };
    const row = await statusShippedFile(file, dest, manifest);
    expect(row).toBeNull();
  });

  it('--prune drops manifest entries whose shipped source no longer exists', async () => {
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
    await install([], { prune: true });
    const manifest = await readManifest(dest);
    expect(manifest!.files!['CLAUDE.md']).toBeUndefined();
  });
});
