/**
 * End-to-end install tests against the shipped conception-template skill tree
 * (read-only fixture) writing into a tmp dest. condash places the skill source
 * layout verbatim — no compile to per-harness dirs.
 */
import { createHash } from 'node:crypto';
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

async function install(extra: { force?: boolean; prune?: boolean } = {}): Promise<void> {
  process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
  await runSkills(
    'install',
    {
      noun: 'skills',
      verb: 'install',
      positional: [],
      flags: {
        dest,
        ...(extra.force ? { force: true } : {}),
        ...(extra.prune ? { prune: true } : {}),
      },
    },
    ctx(),
  );
}

/** `skills status` rows for the tmp dest, straight off the JSON envelope. */
async function statusRows(): Promise<{ skill: string; file: string; state: string }[]> {
  process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runSkills(
      'status',
      { noun: 'skills', verb: 'status', positional: [], flags: { dest } },
      ctx(),
    );
  } finally {
    process.stdout.write = write;
  }
  const envelope = JSON.parse(chunks.join('')) as {
    data: { items: { skill: string; file: string; state: string }[] };
  };
  return envelope.data.items;
}

/** Add a manifest entry for a file the bundle does not ship — a layout ghost. */
async function seedGhostEntry(skill: string, relPath: string): Promise<void> {
  const manifestPath = join(dest, '.agents', MANIFEST_RELPATH);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
    skills: Record<string, { source: Record<string, { sha256: string; shippedVersion: string }> }>;
  };
  manifest.skills[skill] ??= { source: {} };
  manifest.skills[skill].source[relPath] = { sha256: 'b'.repeat(64), shippedVersion: '3.35.2' };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
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

  it('reports a manifest entry the bundle no longer ships as source-missing, not missing', async () => {
    // An entry from a superseded layout (`body.md`, `spec.yaml`, …) is absent
    // from disk *and* from the bundle. Reporting it as `missing` read like real
    // drift and padded the output enough to bury genuine `outdated` rows.
    await install();
    await seedGhostEntry('knowledge', 'body.md');
    const rows = await statusRows();
    const ghost = rows.find((r) => r.skill === 'knowledge' && r.file === 'body.md');
    expect(ghost?.state).toBe('source-missing');
    expect(rows.filter((r) => r.state === 'missing')).toEqual([]);
  });

  it('--prune drops a stale per-file entry under a still-shipped skill', async () => {
    await install();
    await seedGhostEntry('knowledge', 'body.md');
    await install({ prune: true });
    const manifest = await readManifest(dest);
    expect(manifest!.skills.knowledge.source['body.md']).toBeUndefined();
    // The skill itself survives — only the entry for the unshipped file goes.
    expect(manifest!.skills.knowledge.source['SKILL.md']).toBeTruthy();
    expect(await statusRows()).not.toContainEqual(expect.objectContaining({ file: 'body.md' }));
  });

  it('--prune removes the source directory of a skill the bundle dropped', async () => {
    await install();
    // Simulate a skill that shipped once and is gone from the current bundle:
    // on disk under .agents/skills/, tracked in the manifest, unmodified.
    const retiredDir = join(dest, '.agents/skills/tidy');
    await fs.mkdir(retiredDir, { recursive: true });
    const body = '# /tidy\n';
    await fs.writeFile(join(retiredDir, 'SKILL.md'), body, 'utf8');
    const manifestPath = join(dest, '.agents', MANIFEST_RELPATH);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      skills: Record<string, { source: Record<string, unknown> }>;
    };
    manifest.skills.tidy = {
      source: {
        'SKILL.md': {
          sha256: createHash('sha256').update(body).digest('hex'),
          shippedVersion: '3.35.2',
        },
      },
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await install({ prune: true });

    await expect(fs.access(retiredDir)).rejects.toThrow();
    const after = await readManifest(dest);
    expect(after!.skills.tidy).toBeUndefined();
  });

  it("--prune keeps a dropped skill's directory when a file in it was edited", async () => {
    await install();
    const retiredDir = join(dest, '.agents/skills/tidy');
    await fs.mkdir(retiredDir, { recursive: true });
    await fs.writeFile(join(retiredDir, 'SKILL.md'), '# /tidy — my own version\n', 'utf8');
    const manifestPath = join(dest, '.agents', MANIFEST_RELPATH);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      skills: Record<string, { source: Record<string, unknown> }>;
    };
    // Hash of the *shipped* content, not what is on disk → locally edited.
    manifest.skills.tidy = {
      source: { 'SKILL.md': { sha256: 'c'.repeat(64), shippedVersion: '3.35.2' } },
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await install({ prune: true });

    // The edit survives; only the manifest entry is dropped.
    const kept = await fs.readFile(join(retiredDir, 'SKILL.md'), 'utf8');
    expect(kept).toContain('my own version');
  });

  it('leaves a conception-local skill alone', async () => {
    // A skill the conception wrote itself is never in the manifest, so no
    // prune path may reason from "absent from the shipped set".
    await install();
    const localDir = join(dest, '.agents/skills/toggl');
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(join(localDir, 'SKILL.md'), '# /toggl\n', 'utf8');
    await install({ prune: true });
    await expect(fs.access(join(localDir, 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('ships a Claude overlay for every shipped skill that shells out to condash', async () => {
    // A skill whose documented path runs `condash …` needs an `allowed-tools`
    // grant, or every call it wraps raises a permission prompt. `applications`
    // and `visual` shipped without one for several releases; this keeps the
    // grant and the shell-out from drifting apart again.
    await install();
    const skillsDir = join(dest, '.agents/skills');
    const names = (await fs.readdir(skillsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(names.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const name of names) {
      const files = await fs.readdir(join(skillsDir, name));
      const bodies = files.filter((f) => f.endsWith('.md') && f !== 'SKILL.claude.md');
      let shellsOut = false;
      for (const file of bodies) {
        const body = await fs.readFile(join(skillsDir, name, file), 'utf8');
        if (/```bash\n[^`]*\bcondash /.test(body)) shellsOut = true;
      }
      if (shellsOut && !files.includes('SKILL.claude.md')) missing.push(name);
    }
    expect(missing).toEqual([]);
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
