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
import {
  AGENT_CONFIG_COMMON,
  SHIPPED_FILES,
  ensureOpencodeConfig,
  statusShippedFile,
} from './files';
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
  it('compiles condash.md + conception.md to .claude/CLAUDE.md + .kimi/AGENTS.md', async () => {
    await install();

    const claude = await fs.readFile(join(dest, '.claude/CLAUDE.md'), 'utf8');
    // Variable substitution: skills_dir → .claude/skills/
    expect(claude).toContain('.claude/skills/projects/SKILL.md');
    // condash.md head (## General) + conception.md tail (## Specifics) both land.
    expect(claude).toContain('## General');
    expect(claude).toContain('## Specifics');
    // Kimi-only fragment excluded from the Claude output.
    expect(claude).not.toContain('Kimi Code CLI');

    const kimi = await fs.readFile(join(dest, '.kimi/AGENTS.md'), 'utf8');
    expect(kimi).toContain('.kimi/skills/projects/SKILL.md');
    // Kimi fragment spliced in before ## Specifics.
    expect(kimi).toContain('Kimi Code CLI');
  });

  it('writes a conception-root opencode.json pointing at the compiled .opencode/AGENTS.md', async () => {
    await install();
    const cfg = JSON.parse(await fs.readFile(join(dest, 'opencode.json'), 'utf8'));
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.instructions).toContain('.opencode/AGENTS.md');
  });

  it('merges into an existing opencode.json without clobbering other keys', async () => {
    await fs.writeFile(
      join(dest, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'deepseek/deepseek-v4-pro',
      }),
    );
    await install();
    const cfg = JSON.parse(await fs.readFile(join(dest, 'opencode.json'), 'utf8'));
    expect(cfg.model).toBe('deepseek/deepseek-v4-pro');
    expect(cfg.instructions).toEqual(['.opencode/AGENTS.md']);
  });

  it('is idempotent — a second install does not duplicate the instructions entry', async () => {
    await install();
    await install();
    const cfg = JSON.parse(await fs.readFile(join(dest, 'opencode.json'), 'utf8'));
    expect(cfg.instructions).toEqual(['.opencode/AGENTS.md']);
  });

  it('writes .gitignore with region replacement', async () => {
    await install(['.gitignore']);

    const gitignore = await fs.readFile(join(dest, '.gitignore'), 'utf8');
    expect(gitignore).toContain('# General');
    expect(gitignore).toContain('# Specifics');
  });

  it('ignores every per-target compiled artefact for all agent targets', async () => {
    await install(['.gitignore']);

    const gitignore = await fs.readFile(join(dest, '.gitignore'), 'utf8');
    // Compiled skill trees — one per agent target.
    expect(gitignore).toContain('.claude/skills/');
    expect(gitignore).toContain('.kimi/skills/');
    expect(gitignore).toContain('.opencode/skills/');
    // Compiled agent-config files — equally build output, from `.agents/agents/`.
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

  it('ships .gitignore under the alias _gitignore (electron-builder filter workaround)', async () => {
    // The destination is .gitignore but the bundled source must be
    // _gitignore — electron-builder drops a top-level .gitignore from the
    // asar by default. The install must still write a `.gitignore` at dest.
    const entry = SHIPPED_FILES.find((f) => f.path === '.gitignore');
    expect(entry?.sourcePath).toBe('_gitignore');
    await fs.access(join(TEMPLATE_ROOT, '_gitignore')); // shipped under alias
    await install(['.gitignore']);
    await fs.access(join(dest, '.gitignore')); // written under real name
  });

  it('status: no row for a user-owned .gitignore (no manifest, no markers)', async () => {
    // Reproduces issue #167: in 3.4.1, `condash skills status` returned a
    // phantom `.gitignore` row with state="missing-heading" whenever the
    // conception had its own `.gitignore` without condash markers — even
    // when the manifest was empty and `install` was a no-op. After the fix,
    // statusShippedFile should report nothing for files condash doesn't
    // manage.
    await fs.writeFile(join(dest, '.gitignore'), 'node_modules\n*.log\n');
    process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
    const file = SHIPPED_FILES.find((f) => f.path === '.gitignore')!;
    const manifest = { version: 3 as const, skills: {}, files: {} };
    const row = await statusShippedFile(file, dest, manifest);
    expect(row).toBeNull();
  });

  it('never overwrites a user-customised conception.md across reinstall', async () => {
    // First install scaffolds condash.md (head) + conception.md (Specifics stub).
    await install();
    const condashPath = join(dest, '.agents/agents/condash.md');
    const conceptionPath = join(dest, '.agents/agents/conception.md');
    const condash = await fs.readFile(condashPath, 'utf8');
    expect(condash).toContain('## General');
    // The head must not carry a `## Specifics` heading — that lives in conception.md.
    expect(condash).not.toMatch(/^## Specifics\s*$/m);
    expect(await fs.readFile(conceptionPath, 'utf8')).toContain('## Specifics');

    // User rewrites conception.md (Apps table + a team rule).
    const customised = [
      '## Specifics',
      '',
      '| App       | Purpose     | Repo                   | Config             | Knowledge |',
      '|-----------|-------------|------------------------|--------------------|-----------|',
      '| `@my-app` | example app | `~/src/example/my-app` | `<repo>/CLAUDE.md` | _(none)_  |',
      '',
      '### Repo workflow',
      '',
      '- Always run `make format` after every code change.',
      '',
    ].join('\n');
    await fs.writeFile(conceptionPath, customised);

    // Second install must NOT touch conception.md (user-owned, never tracked).
    await install();
    const after = await fs.readFile(conceptionPath, 'utf8');
    expect(after).toBe(customised);
    expect(after).not.toContain('_(populate per-app)_');

    // Compiled outputs must carry the customised Specifics rows.
    const claude = await fs.readFile(join(dest, '.claude/CLAUDE.md'), 'utf8');
    expect(claude).toContain('`@my-app`');
    expect(claude).toContain('Always run `make format`');
    const kimi = await fs.readFile(join(dest, '.kimi/AGENTS.md'), 'utf8');
    expect(kimi).toContain('`@my-app`');

    // Manifest tracks condash.md (the shipped head) — never conception.md.
    const manifest = await readManifest(dest);
    expect(manifest!.files![AGENT_CONFIG_COMMON.path]).toBeTruthy();
    expect(manifest!.files![AGENT_CONFIG_COMMON.path].region).toBe('General');
    expect(manifest!.files!['.agents/agents/conception.md']).toBeUndefined();
  });

  it('scaffolds conception.md from the stub when absent', async () => {
    await install();
    await fs.rm(join(dest, '.agents/agents/conception.md'));
    await install();
    const conception = await fs.readFile(join(dest, '.agents/agents/conception.md'), 'utf8');
    expect(conception).toContain('## Specifics');
  });

  it('migrates a legacy common.md into condash.md + conception.md, preserving Specifics', async () => {
    // Scaffold the split tree, then reconstruct a pre-split state: a single
    // common.md (head + a user Specifics), manifest tracking common.md, and
    // the split files removed.
    await install();
    const agentsDir = join(dest, '.agents/agents');
    const head = await fs.readFile(join(agentsDir, 'condash.md'), 'utf8');
    const userSpecifics = '## Specifics\n\n- Team rule: always do X.\n';
    await fs.writeFile(join(agentsDir, 'common.md'), `${head.trimEnd()}\n\n${userSpecifics}`);
    await fs.rm(join(agentsDir, 'condash.md'));
    await fs.rm(join(agentsDir, 'conception.md'));
    // Re-point the manifest entry at the legacy common.md path.
    const manifestPath = join(dest, '.agents', MANIFEST_RELPATH);
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    m.files['.agents/agents/common.md'] = m.files[AGENT_CONFIG_COMMON.path];
    delete m.files[AGENT_CONFIG_COMMON.path];
    await fs.writeFile(manifestPath, JSON.stringify(m, null, 2));

    await install();

    // common.md is split + removed; the split files exist.
    await expect(fs.access(join(agentsDir, 'common.md'))).rejects.toThrow();
    expect(await fs.readFile(join(agentsDir, 'condash.md'), 'utf8')).toContain('## General');
    expect(await fs.readFile(join(agentsDir, 'conception.md'), 'utf8')).toContain(
      'Team rule: always do X',
    );
    // The compiled output keeps the user's Specifics.
    expect(await fs.readFile(join(dest, '.claude/CLAUDE.md'), 'utf8')).toContain(
      'Team rule: always do X',
    );
    // Manifest entry carried forward to condash.md; stale common.md entry gone.
    const manifest = await readManifest(dest);
    expect(manifest!.files![AGENT_CONFIG_COMMON.path]).toBeTruthy();
    expect(manifest!.files!['.agents/agents/common.md']).toBeUndefined();
  });

  it('--prune does not drop the .agents/agents/condash.md manifest entry', async () => {
    await install();
    process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
    await runSkills(
      'install',
      { noun: 'skills', verb: 'install', positional: [], flags: { dest, prune: true } },
      ctx(),
    );
    const manifest = await readManifest(dest);
    expect(manifest!.files![AGENT_CONFIG_COMMON.path]).toBeTruthy();
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

describe('ensureOpencodeConfig', () => {
  it('creates opencode.json with the schema + instructions entry when absent', async () => {
    const outcome = await ensureOpencodeConfig(dest, false);
    expect(outcome.state).toBe('created');
    const cfg = JSON.parse(await fs.readFile(join(dest, 'opencode.json'), 'utf8'));
    expect(cfg).toEqual({
      $schema: 'https://opencode.ai/config.json',
      instructions: ['.opencode/AGENTS.md'],
    });
  });

  it('merges the entry into an existing config, preserving other keys + entries', async () => {
    await fs.writeFile(
      join(dest, 'opencode.json'),
      JSON.stringify({ model: 'x', instructions: ['docs/extra.md'] }),
    );
    const outcome = await ensureOpencodeConfig(dest, false);
    expect(outcome.state).toBe('merged');
    const cfg = JSON.parse(await fs.readFile(join(dest, 'opencode.json'), 'utf8'));
    expect(cfg.model).toBe('x');
    expect(cfg.instructions).toEqual(['docs/extra.md', '.opencode/AGENTS.md']);
  });

  it('is a no-op when the entry is already present', async () => {
    await fs.writeFile(
      join(dest, 'opencode.json'),
      JSON.stringify({ instructions: ['.opencode/AGENTS.md'] }),
    );
    const before = await fs.readFile(join(dest, 'opencode.json'), 'utf8');
    const outcome = await ensureOpencodeConfig(dest, false);
    expect(outcome.state).toBe('unchanged');
    expect(await fs.readFile(join(dest, 'opencode.json'), 'utf8')).toBe(before);
  });

  it('skips a malformed existing opencode.json instead of clobbering it', async () => {
    await fs.writeFile(join(dest, 'opencode.json'), '{ not valid json ');
    const outcome = await ensureOpencodeConfig(dest, false);
    expect(outcome.state).toBe('skipped');
    expect(await fs.readFile(join(dest, 'opencode.json'), 'utf8')).toBe('{ not valid json ');
  });

  it('skips when "instructions" exists but is not an array', async () => {
    await fs.writeFile(join(dest, 'opencode.json'), JSON.stringify({ instructions: 'oops' }));
    const outcome = await ensureOpencodeConfig(dest, false);
    expect(outcome.state).toBe('skipped');
  });

  it('writes nothing in dry-run', async () => {
    const outcome = await ensureOpencodeConfig(dest, true);
    expect(outcome.state).toBe('created');
    await expect(fs.access(join(dest, 'opencode.json'))).rejects.toThrow();
  });
});
