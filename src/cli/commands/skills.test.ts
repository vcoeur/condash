/**
 * End-to-end install tests against the shipped conception-template
 * skillspec tree (read-only fixture) writing into a tmp dest.
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

describe('condash skills install (skillspec mode)', () => {
  it('writes sources to .agents/skills/ and outputs to both targets', async () => {
    await install();

    // Source files for `pr` (a sibling-free skill) — should exist.
    const prSpec = await fs.readFile(join(dest, '.agents/skills/pr/spec.yaml'), 'utf8');
    expect(prSpec).toMatch(/description:/);
    const prBody = await fs.readFile(join(dest, '.agents/skills/pr/body.md'), 'utf8');
    expect(prBody).toMatch(/# \/pr/);

    // Claude output for `pr` — frontmatter + body merged.
    const claudeOut = await fs.readFile(join(dest, '.claude/skills/pr/SKILL.md'), 'utf8');
    expect(claudeOut).toMatch(/^---\n/);
    expect(claudeOut).toContain('description:');
    expect(claudeOut).toContain('allowed-tools:');
    expect(claudeOut).toMatch(/# \/pr/);

    // Kimi output for `pr` — frontmatter has no allowed-tools.
    const kimiOut = await fs.readFile(join(dest, '.kimi/skills/pr/SKILL.md'), 'utf8');
    expect(kimiOut).toMatch(/^---\n/);
    expect(kimiOut).toContain('description:');
    expect(kimiOut).not.toContain('allowed-tools:');
    expect(kimiOut).toMatch(/# \/pr/);
  });

  it('copies sibling assets to both target trees', async () => {
    await install();
    // `projects` ships several siblings (close.md, create.md, …).
    const claudeClose = await fs.readFile(join(dest, '.claude/skills/projects/close.md'), 'utf8');
    const kimiClose = await fs.readFile(join(dest, '.kimi/skills/projects/close.md'), 'utf8');
    expect(claudeClose).toBe(kimiClose);
    expect(claudeClose.length).toBeGreaterThan(0);
  });

  it('records source files in the v2 manifest', async () => {
    await install();
    const manifest = await readManifest(dest);
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(2);
    const pr = manifest!.skills.pr;
    expect(pr).toBeTruthy();
    expect(Object.keys(pr.source).sort()).toEqual(['body.md', 'spec.yaml', 'targets/claude.yaml']);
    for (const entry of Object.values(pr.source)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses to overwrite a user-edited source file without --force', async () => {
    await install();
    await fs.writeFile(join(dest, '.agents/skills/pr/body.md'), 'tampered\n');
    await expect(install()).rejects.toThrow(/refused/);
  });

  it('--force overrides refuse-on-edit and recompiles', async () => {
    await install();
    await fs.writeFile(join(dest, '.agents/skills/pr/body.md'), '# Tampered\n');
    await install({ force: true });
    const body = await fs.readFile(join(dest, '.agents/skills/pr/body.md'), 'utf8');
    expect(body).toMatch(/# \/pr/); // shipped content restored
  });

  it('regenerates outputs on each install (idempotent)', async () => {
    await install();
    const before = await fs.readFile(join(dest, '.claude/skills/pr/SKILL.md'));
    await install();
    const after = await fs.readFile(join(dest, '.claude/skills/pr/SKILL.md'));
    expect(before.equals(after)).toBe(true);
  });

  it('strips stale output files that no longer exist in the source', async () => {
    await install();
    // Plant a stale file in the Claude output tree.
    const stale = join(dest, '.claude/skills/pr/stale.md');
    await fs.writeFile(stale, 'stale\n');
    // Re-install: outputs are wiped + regenerated; stale.md should be gone.
    await install();
    await expect(fs.access(stale)).rejects.toThrow();
  });

  it('migrates a v1 manifest in-place without error', async () => {
    // Plant a v1 manifest that would have failed under the old "exact version match" check.
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
    expect(manifest!.version).toBe(2);
    // The v1 skills section is discarded; the v1 templates section carries forward.
    expect(manifest!.templates).toBeDefined();
    expect(manifest!.skills.pr.source['spec.yaml']).toBeTruthy();
  });
});
