/**
 * End-to-end install tests against the shipped conception-template skill tree
 * (read-only fixture) writing into a tmp dest. condash places the skill source
 * layout verbatim — no compile to per-harness dirs.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkills } from './skills';
import { MANIFEST_RELPATH, readManifest } from './install-shared';
import type { OutputContext } from '../output';

const TEMPLATE_ROOT = resolve(__dirname, '..', '..', '..', 'conception-template');

let dest: string;

beforeEach(async () => {
  dest = await fs.mkdtemp(join(tmpdir(), 'skills-install-'));
});

afterEach(async () => {
  await fs.rm(dest, { recursive: true, force: true });
});

function ctx(): OutputContext {
  return { json: true, ndjson: false, quiet: true, noColor: true };
}

async function install(extra: { force?: boolean } = {}): Promise<void> {
  process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
  await runSkills(
    'install',
    {
      noun: 'skills',
      verb: 'install',
      positional: [],
      flags: { dest, ...(extra.force ? { force: true } : {}) },
    },
    ctx(),
  );
}

describe('condash skills install (verbatim placement)', () => {
  it('places skill sources under .agents/skills/ and does not compile', async () => {
    await install();

    // `pr` ships SKILL.md (frontmatter + body) + a Claude overlay.
    const prSkill = await fs.readFile(join(dest, '.agents/skills/pr/SKILL.md'), 'utf8');
    expect(prSkill).toMatch(/^---\n/);
    expect(prSkill).toContain('name: pr');
    expect(prSkill).toContain('description:');
    expect(prSkill).toMatch(/# \/pr/);

    const prOverlay = await fs.readFile(join(dest, '.agents/skills/pr/SKILL.claude.md'), 'utf8');
    expect(prOverlay).toContain('allowed-tools:');

    // No compile to per-harness dirs.
    await expect(fs.access(join(dest, '.claude/skills'))).rejects.toThrow();
    await expect(fs.access(join(dest, '.kimi/skills'))).rejects.toThrow();
  });

  it('copies task files alongside SKILL.md', async () => {
    await install();
    // `projects` ships several task files (close.md, create.md, …).
    const close = await fs.readFile(join(dest, '.agents/skills/projects/close.md'), 'utf8');
    expect(close.length).toBeGreaterThan(0);
  });

  it('records source files in the v3 manifest', async () => {
    await install();
    const manifest = await readManifest(dest);
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(3);
    const pr = manifest!.skills.pr;
    expect(pr).toBeTruthy();
    expect(Object.keys(pr.source).sort()).toEqual(['SKILL.claude.md', 'SKILL.md']);
    for (const entry of Object.values(pr.source)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses to overwrite a user-edited source file without --force', async () => {
    await install();
    await fs.writeFile(join(dest, '.agents/skills/pr/SKILL.md'), 'tampered\n');
    await expect(install()).rejects.toThrow(/refused/);
  });

  it('--force overrides refuse-on-edit and restores shipped content', async () => {
    await install();
    await fs.writeFile(join(dest, '.agents/skills/pr/SKILL.md'), '# Tampered\n');
    await install({ force: true });
    const body = await fs.readFile(join(dest, '.agents/skills/pr/SKILL.md'), 'utf8');
    expect(body).toMatch(/# \/pr/); // shipped content restored
  });

  it('is idempotent — a second install leaves sources byte-identical', async () => {
    await install();
    const before = await fs.readFile(join(dest, '.agents/skills/pr/SKILL.md'));
    await install();
    const after = await fs.readFile(join(dest, '.agents/skills/pr/SKILL.md'));
    expect(before.equals(after)).toBe(true);
  });

  it('migrates a v1 manifest in-place without error', async () => {
    const manifestPath = join(dest, '.claude/skills', MANIFEST_RELPATH);
    await fs.mkdir(dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          skills: { pr: { files: { 'SKILL.md': { sha256: 'x', shippedVersion: '2.27.0' } } } },
          templates: { 'AGENTS.md': { region: 'General', sha256: 'y', shippedVersion: '2.27.0' } },
        },
        null,
        2,
      ),
    );
    await install();
    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    // The v1 skills section is discarded; the v1 templates section carries
    // forward into the v3 `files` namespace.
    expect(manifest!.files).toBeDefined();
    expect(manifest!.files!['AGENTS.md']).toBeTruthy();
    // pr is re-tracked from its new source layout.
    expect(manifest!.skills.pr.source['SKILL.md']).toBeTruthy();
  });

  it('migrates a v2 manifest with `templates` to v3 `files`', async () => {
    const manifestPath = join(dest, '.claude/skills', MANIFEST_RELPATH);
    await fs.mkdir(dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 2,
          skills: {},
          templates: {
            'AGENTS.md': { region: 'General', sha256: 'y'.repeat(64), shippedVersion: '2.30.0' },
          },
        },
        null,
        2,
      ),
    );
    await install();
    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    expect(manifest!.files!['AGENTS.md']).toBeTruthy();
    expect((manifest as unknown as { templates?: unknown }).templates).toBeUndefined();
  });

  it('normalizes a v3 manifest whose per-skill entry predates the source split', async () => {
    // The pre-v4 v3 schema tracked compiled outputs under a per-skill `files`
    // key with no `source` map. Reusing version 3 across the schema change,
    // this used to crash install with "Cannot set properties of undefined
    // (setting 'SKILL.claude.md')" — the first source file written for a skill.
    const manifestPath = join(dest, '.agents', MANIFEST_RELPATH);
    await fs.mkdir(dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 3,
          skills: {
            knowledge: {
              files: { 'SKILL.md': { sha256: 'a'.repeat(64), shippedVersion: '3.1.0' } },
            },
          },
        },
        null,
        2,
      ),
    );
    await install(); // must not throw
    const manifest = await readManifest(dest);
    expect(manifest!.version).toBe(3);
    // The stale `files` map is discarded; the entry is re-seeded from sources.
    expect(manifest!.skills.knowledge.source['SKILL.md']).toBeTruthy();
    expect((manifest!.skills.knowledge as unknown as { files?: unknown }).files).toBeUndefined();
  });
});
