/**
 * End-to-end tests for `condash skills <verb> --user`.
 *
 * User scope has no shipped tree: the user owns the source at
 * `~/.config/agents/skills/` and condash compiles to `~/.claude/skills/`
 * + `~/.kimi/skills/`. All four paths (plus the host-label file) are
 * env-overridable for hermetic tests.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkills } from './skills';
import type { OutputContext } from '../output';

/** Read the compiled kimi instructions file (plain markdown — the launcher
 *  wraps it into a transient agent-file at spawn). */
async function readKimiContent(path: string): Promise<string> {
  return fs.readFile(path, 'utf8');
}

let root: string;
let sourceRoot: string;
let claudeRoot: string;
let kimiRoot: string;
let hostFile: string;
let agentsScriptsSource: string;
let claudeScriptsSource: string;
let agentsScriptsTarget: string;
let claudeScriptsTarget: string;
let agentConfigRoot: string;
let claudeAgentOutput: string;
let kimiAgentOutput: string;
let opencodeRoot: string;
let opencodeAgentOutput: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'skills-user-'));
  sourceRoot = join(root, 'src');
  claudeRoot = join(root, 'claude');
  kimiRoot = join(root, 'kimi');
  hostFile = join(root, '.host');
  agentsScriptsSource = join(root, 'agents-scripts-src');
  claudeScriptsSource = join(root, 'claude-scripts-src');
  agentsScriptsTarget = join(root, 'agents-scripts-tgt');
  claudeScriptsTarget = join(root, 'claude-scripts-tgt');
  agentConfigRoot = join(root, 'agent-config-src');
  claudeAgentOutput = join(root, 'claude-CLAUDE.md');
  kimiAgentOutput = join(root, 'kimi-AGENTS.md');
  opencodeRoot = join(root, 'opencode');
  opencodeAgentOutput = join(root, 'opencode-AGENTS.md');
  await fs.mkdir(sourceRoot, { recursive: true });
  process.env.CONDASH_USER_SKILLS_ROOT = sourceRoot;
  process.env.CONDASH_USER_CLAUDE_ROOT = claudeRoot;
  process.env.CONDASH_USER_KIMI_ROOT = kimiRoot;
  process.env.CONDASH_USER_HOST_FILE = hostFile;
  process.env.CONDASH_USER_AGENTS_SCRIPTS_ROOT = agentsScriptsSource;
  process.env.CONDASH_USER_CLAUDE_SCRIPTS_ROOT = claudeScriptsSource;
  process.env.CONDASH_USER_AGENTS_SCRIPTS_TARGET = agentsScriptsTarget;
  process.env.CONDASH_USER_CLAUDE_SCRIPTS_TARGET = claudeScriptsTarget;
  process.env.CONDASH_USER_AGENT_CONFIG_ROOT = agentConfigRoot;
  process.env.CONDASH_USER_CLAUDE_AGENT_OUTPUT = claudeAgentOutput;
  process.env.CONDASH_USER_KIMI_AGENT_OUTPUT = kimiAgentOutput;
  process.env.CONDASH_USER_OPENCODE_ROOT = opencodeRoot;
  process.env.CONDASH_USER_OPENCODE_AGENT_OUTPUT = opencodeAgentOutput;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.CONDASH_USER_SKILLS_ROOT;
  delete process.env.CONDASH_USER_CLAUDE_ROOT;
  delete process.env.CONDASH_USER_KIMI_ROOT;
  delete process.env.CONDASH_USER_HOST_FILE;
  delete process.env.CONDASH_USER_AGENTS_SCRIPTS_ROOT;
  delete process.env.CONDASH_USER_CLAUDE_SCRIPTS_ROOT;
  delete process.env.CONDASH_USER_AGENTS_SCRIPTS_TARGET;
  delete process.env.CONDASH_USER_CLAUDE_SCRIPTS_TARGET;
  delete process.env.CONDASH_USER_AGENT_CONFIG_ROOT;
  delete process.env.CONDASH_USER_CLAUDE_AGENT_OUTPUT;
  delete process.env.CONDASH_USER_KIMI_AGENT_OUTPUT;
  delete process.env.CONDASH_USER_OPENCODE_ROOT;
  delete process.env.CONDASH_USER_OPENCODE_AGENT_OUTPUT;
});

function ctx(): OutputContext {
  return { json: true, ndjson: false, quiet: true, noColor: true };
}

/** Capture the single `--json` envelope written to stdout while `fn` runs. */
async function captureJson<T = unknown>(fn: () => Promise<void>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  // The envelope is a single JSON line.
  const raw = chunks.join('');
  return JSON.parse(raw) as T;
}

async function writeSkill(
  name: string,
  opts: {
    spec: Record<string, unknown>;
    body: string;
    claudeOverlay?: Record<string, unknown>;
    extraFiles?: Record<string, string>;
  },
): Promise<void> {
  const dir = join(sourceRoot, name);
  await fs.mkdir(dir, { recursive: true });
  const specLines = Object.entries(opts.spec)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    })
    .join('\n');
  await fs.writeFile(join(dir, 'spec.yaml'), specLines + '\n');
  await fs.writeFile(join(dir, 'body.md'), opts.body);
  if (opts.claudeOverlay) {
    await fs.mkdir(join(dir, 'targets'), { recursive: true });
    const overlayLines = Object.entries(opts.claudeOverlay)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
    await fs.writeFile(join(dir, 'targets', 'claude.yaml'), overlayLines + '\n');
  }
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    const p = join(dir, rel);
    await fs.mkdir(join(p, '..'), { recursive: true });
    await fs.writeFile(p, content);
  }
}

async function install(
  positional: string[] = [],
  extra: Record<string, boolean> = {},
): Promise<void> {
  await runSkills(
    'install',
    {
      noun: 'skills',
      verb: 'install',
      positional,
      flags: { user: true, ...extra },
    },
    ctx(),
  );
}

describe('condash skills install --user', () => {
  it('compiles a skillspec into ~/.claude/skills/ and ~/.kimi/skills/', async () => {
    await writeSkill('foo', {
      spec: { description: 'foo skill' },
      body: '# /foo\n\nhello\n',
      claudeOverlay: { 'allowed-tools': 'Read, Write' },
    });
    await install();

    const claudeOut = await fs.readFile(join(claudeRoot, 'foo', 'SKILL.md'), 'utf8');
    expect(claudeOut).toMatch(/^---\n/);
    expect(claudeOut).toContain('description: foo skill');
    expect(claudeOut).toContain('allowed-tools: Read, Write');
    expect(claudeOut).toContain('# /foo');

    const kimiOut = await fs.readFile(join(kimiRoot, 'foo', 'SKILL.md'), 'utf8');
    expect(kimiOut).toContain('description: foo skill');
    expect(kimiOut).not.toContain('allowed-tools:');
  });

  it('copies sibling assets to both target trees', async () => {
    await writeSkill('foo', {
      spec: { description: 'foo' },
      body: '# /foo\n',
      extraFiles: { 'helper.md': 'helper content\n' },
    });
    await install();
    const claudeHelper = await fs.readFile(join(claudeRoot, 'foo', 'helper.md'), 'utf8');
    const kimiHelper = await fs.readFile(join(kimiRoot, 'foo', 'helper.md'), 'utf8');
    expect(claudeHelper).toBe('helper content\n');
    expect(kimiHelper).toBe('helper content\n');
  });

  it('skips a skill whose hosts: does not include the current host', async () => {
    await fs.writeFile(hostFile, 'oomade\n');
    await writeSkill('vc-only', {
      spec: { description: 'vcoeur-only', hosts: ['vcoeur'] },
      body: '# /vc\n',
    });
    await writeSkill('global', {
      spec: { description: 'global' },
      body: '# /global\n',
    });
    await install();
    // vc-only should NOT be installed
    await expect(fs.access(join(claudeRoot, 'vc-only', 'SKILL.md'))).rejects.toThrow();
    // global should be installed
    const globalOut = await fs.readFile(join(claudeRoot, 'global', 'SKILL.md'), 'utf8');
    expect(globalOut).toContain('description: global');
  });

  it('installs a hosts:-restricted skill when the host matches', async () => {
    await fs.writeFile(hostFile, 'vcoeur\n');
    await writeSkill('vc-only', {
      spec: { description: 'vcoeur-only', hosts: ['vcoeur'] },
      body: '# /vc\n',
    });
    await install();
    const out = await fs.readFile(join(claudeRoot, 'vc-only', 'SKILL.md'), 'utf8');
    expect(out).toContain('description: vcoeur-only');
  });

  it('skips a hosts:-restricted skill when no host file is present', async () => {
    await writeSkill('vc-only', {
      spec: { description: 'vcoeur-only', hosts: ['vcoeur'] },
      body: '# /vc\n',
    });
    await install();
    await expect(fs.access(join(claudeRoot, 'vc-only', 'SKILL.md'))).rejects.toThrow();
  });

  it('regenerates outputs on each install (idempotent)', async () => {
    await writeSkill('foo', { spec: { description: 'foo' }, body: '# /foo\n' });
    await install();
    const before = await fs.readFile(join(claudeRoot, 'foo', 'SKILL.md'));
    await install();
    const after = await fs.readFile(join(claudeRoot, 'foo', 'SKILL.md'));
    expect(before.equals(after)).toBe(true);
  });

  it('strips stale output files that no longer exist in the source', async () => {
    await writeSkill('foo', {
      spec: { description: 'foo' },
      body: '# /foo\n',
      extraFiles: { 'helper.md': 'h\n' },
    });
    await install();
    await fs.unlink(join(sourceRoot, 'foo', 'helper.md'));
    await install();
    await expect(fs.access(join(claudeRoot, 'foo', 'helper.md'))).rejects.toThrow();
  });

  it('only compiles requested skills when positional names are given', async () => {
    await writeSkill('foo', { spec: { description: 'foo' }, body: '# /foo\n' });
    await writeSkill('bar', { spec: { description: 'bar' }, body: '# /bar\n' });
    await install(['foo']);
    await fs.access(join(claudeRoot, 'foo', 'SKILL.md'));
    await expect(fs.access(join(claudeRoot, 'bar', 'SKILL.md'))).rejects.toThrow();
  });

  it('errors on unknown skill names', async () => {
    await writeSkill('foo', { spec: { description: 'foo' }, body: '# /foo\n' });
    await expect(install(['nope'])).rejects.toThrow(/Unknown skill/);
  });

  it('--dry-run does not write to disk', async () => {
    await writeSkill('foo', { spec: { description: 'foo' }, body: '# /foo\n' });
    await install([], { 'dry-run': true });
    await expect(fs.access(join(claudeRoot, 'foo', 'SKILL.md'))).rejects.toThrow();
  });

  it('rejects --user combined with --dest', async () => {
    await expect(
      runSkills(
        'install',
        {
          noun: 'skills',
          verb: 'install',
          positional: [],
          flags: { user: true, dest: '/tmp' },
        },
        ctx(),
      ),
    ).rejects.toThrow(/--user.*incompatible.*--dest|--dest.*--user/i);
  });

  it('handles a missing source root gracefully (empty list)', async () => {
    // Wipe the source dir we created in beforeEach so the root is missing.
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await install();
    // No outputs should be written.
    await expect(fs.readdir(claudeRoot)).rejects.toThrow();
  });
});

describe('condash skills list --user', () => {
  it('lists user skillspecs', async () => {
    await writeSkill('alpha', { spec: { description: 'alpha desc' }, body: 'a\n' });
    await writeSkill('beta', { spec: { description: 'beta desc' }, body: 'b\n' });
    const env = await captureJson<{ data: { skills: { name: string }[] } }>(() =>
      runSkills(
        'list',
        { noun: 'skills', verb: 'list', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    expect(env.data.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('marks a hosts:-restricted skill as skipped on a non-matching host', async () => {
    await fs.writeFile(hostFile, 'oomade\n');
    await writeSkill('vc-only', {
      spec: { description: 'vc', hosts: ['vcoeur'] },
      body: 'x\n',
    });
    const env = await captureJson<{
      data: { hostLabel: string | null; skills: { name: string; allowedOnHost: boolean }[] };
    }>(() =>
      runSkills(
        'list',
        { noun: 'skills', verb: 'list', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    expect(env.data.hostLabel).toBe('oomade');
    expect(env.data.skills.find((s) => s.name === 'vc-only')?.allowedOnHost).toBe(false);
  });
});

describe('condash skills validate --user', () => {
  it('passes for a valid skill', async () => {
    await writeSkill('foo', { spec: { description: 'foo' }, body: '# /foo\n' });
    await runSkills(
      'validate',
      { noun: 'skills', verb: 'validate', positional: [], flags: { user: true } },
      ctx(),
    );
  });

  it('fails for a spec missing description', async () => {
    const dir = join(sourceRoot, 'bad');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'spec.yaml'), 'name: bad\n');
    await fs.writeFile(join(dir, 'body.md'), 'x\n');
    await expect(
      runSkills(
        'validate',
        { noun: 'skills', verb: 'validate', positional: [], flags: { user: true } },
        ctx(),
      ),
    ).rejects.toThrow(/validation error/);
  });
});

describe('condash skills status --user', () => {
  it('reports ok after install, stale after edit, missing after delete', async () => {
    await writeSkill('foo', { spec: { description: 'foo' }, body: '# /foo\n' });
    await install();

    type StatusEnv = { data: { items: { state: string }[] } };

    let env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    expect(env.data.items.every((i) => i.state === 'ok')).toBe(true);

    await fs.writeFile(join(claudeRoot, 'foo', 'SKILL.md'), 'tampered\n');
    env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    expect(env.data.items.some((i) => i.state === 'stale')).toBe(true);

    await fs.unlink(join(claudeRoot, 'foo', 'SKILL.md'));
    env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    expect(env.data.items.some((i) => i.state === 'missing')).toBe(true);
  });
});

async function writeScript(
  category: 'agents' | 'claude',
  relPath: string,
  content: string,
): Promise<void> {
  const root = category === 'agents' ? agentsScriptsSource : claudeScriptsSource;
  const p = join(root, relPath);
  await fs.mkdir(join(p, '..'), { recursive: true });
  await fs.writeFile(p, content);
}

describe('condash skills install --user (scripts)', () => {
  it('completes when both script sources are absent', async () => {
    await install();
    // No source dirs → no script rows, no error. Targets must not be created.
    await expect(fs.access(agentsScriptsTarget)).rejects.toThrow();
    await expect(fs.access(claudeScriptsTarget)).rejects.toThrow();
  });

  it('installs an agents-scripts/ file with +x', async () => {
    await writeScript('agents', 'md_to_pdf.sh', '#!/usr/bin/env bash\necho hi\n');
    await install();
    const target = join(agentsScriptsTarget, 'md_to_pdf.sh');
    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('#!/usr/bin/env bash\necho hi\n');
    const stat = await fs.stat(target);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('installs a claude-scripts/ file with +x', async () => {
    await writeScript('claude', 'cp-hook.sh', '#!/usr/bin/env bash\nexit 0\n');
    await install();
    const target = join(claudeScriptsTarget, 'cp-hook.sh');
    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('#!/usr/bin/env bash\nexit 0\n');
    const stat = await fs.stat(target);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('installs both categories together, including a .py file', async () => {
    await writeScript('agents', 'md_to_pdf.sh', '#!/usr/bin/env bash\n');
    await writeScript('claude', 'cp-hook.sh', '#!/usr/bin/env bash\n');
    await writeScript('claude', 'tmp-allow-hook.py', '#!/usr/bin/env python3\nimport sys\n');
    await install();
    await fs.access(join(agentsScriptsTarget, 'md_to_pdf.sh'));
    await fs.access(join(claudeScriptsTarget, 'cp-hook.sh'));
    const py = join(claudeScriptsTarget, 'tmp-allow-hook.py');
    expect(await fs.readFile(py, 'utf8')).toBe('#!/usr/bin/env python3\nimport sys\n');
    expect((await fs.stat(py)).mode & 0o111).not.toBe(0);
  });

  it('--dry-run reports installs without touching disk', async () => {
    await writeScript('agents', 'md_to_pdf.sh', '#!/usr/bin/env bash\n');
    type Env = {
      data: { scripts: { installed: { category: string; relPath: string }[] } };
    };
    const env = await captureJson<Env>(() =>
      runSkills(
        'install',
        {
          noun: 'skills',
          verb: 'install',
          positional: [],
          flags: { user: true, 'dry-run': true },
        },
        ctx(),
      ),
    );
    expect(env.data.scripts.installed).toEqual([{ category: 'agents', relPath: 'md_to_pdf.sh' }]);
    await expect(fs.access(join(agentsScriptsTarget, 'md_to_pdf.sh'))).rejects.toThrow();
  });

  it('status reports ok / stale / missing for scripts', async () => {
    await writeScript('agents', 'md_to_pdf.sh', 'content-a\n');
    await writeScript('claude', 'cp-hook.sh', 'content-b\n');
    await install();

    type StatusEnv = {
      data: {
        items: ({ kind: string; relPath: string; state: string } | Record<string, unknown>)[];
      };
    };

    // After install: both scripts should report ok.
    let env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    const scriptRows = (
      env.data.items as { kind: string; relPath: string; state: string }[]
    ).filter((r) => r.kind === 'script');
    expect(scriptRows.length).toBe(2);
    expect(scriptRows.every((r) => r.state === 'ok')).toBe(true);

    // Tamper with one target: should report stale.
    await fs.writeFile(join(agentsScriptsTarget, 'md_to_pdf.sh'), 'tampered\n');
    env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    const tamperedRow = (env.data.items as { kind: string; relPath: string; state: string }[]).find(
      (r) => r.kind === 'script' && r.relPath === 'md_to_pdf.sh',
    );
    expect(tamperedRow?.state).toBe('stale');

    // Remove a target: should report missing.
    await fs.unlink(join(claudeScriptsTarget, 'cp-hook.sh'));
    env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    const missingRow = (env.data.items as { kind: string; relPath: string; state: string }[]).find(
      (r) => r.kind === 'script' && r.relPath === 'cp-hook.sh',
    );
    expect(missingRow?.state).toBe('missing');
  });

  it('list includes a scripts block per category when files exist', async () => {
    await writeScript('agents', 'md_to_pdf.sh', '#!/usr/bin/env bash\n');
    await writeScript('claude', 'cp-hook.sh', '#!/usr/bin/env bash\n');
    type ListEnv = {
      data: {
        scripts: {
          agents: { source: string; target: string; files: string[] };
          claude: { source: string; target: string; files: string[] };
        };
      };
    };
    const env = await captureJson<ListEnv>(() =>
      runSkills(
        'list',
        { noun: 'skills', verb: 'list', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    expect(env.data.scripts.agents.files).toEqual(['md_to_pdf.sh']);
    expect(env.data.scripts.claude.files).toEqual(['cp-hook.sh']);
    expect(env.data.scripts.agents.target).toBe(agentsScriptsTarget);
    expect(env.data.scripts.claude.target).toBe(claudeScriptsTarget);
  });

  it('install is idempotent and overwrites without refuse-on-edit', async () => {
    await writeScript('agents', 'md_to_pdf.sh', 'original\n');
    await install();
    // User edits the target directly:
    await fs.writeFile(join(agentsScriptsTarget, 'md_to_pdf.sh'), 'edited-locally\n');
    // Source unchanged. Re-install overwrites without prompting.
    await install();
    const after = await fs.readFile(join(agentsScriptsTarget, 'md_to_pdf.sh'), 'utf8');
    expect(after).toBe('original\n');
  });
});

async function writeAgentConfig(files: {
  common?: string;
  claude?: string;
  kimi?: string;
}): Promise<void> {
  await fs.mkdir(agentConfigRoot, { recursive: true });
  if (files.common !== undefined) {
    await fs.writeFile(join(agentConfigRoot, 'common.md'), files.common);
  }
  if (files.claude !== undefined) {
    await fs.writeFile(join(agentConfigRoot, 'claude.md'), files.claude);
  }
  if (files.kimi !== undefined) {
    await fs.writeFile(join(agentConfigRoot, 'kimi.md'), files.kimi);
  }
}

describe('condash skills install --user (agent-config compile)', () => {
  it('skips when common.md is absent', async () => {
    await install();
    await expect(fs.access(claudeAgentOutput)).rejects.toThrow();
    await expect(fs.access(kimiAgentOutput)).rejects.toThrow();
  });

  it('compiles common.md with no per-agent fragments to both outputs', async () => {
    await writeAgentConfig({ common: '# Global rules\n\nUse short variable names.\n' });
    await install();

    // Claude: full markdown at the output path.
    const claudeContent = await fs.readFile(claudeAgentOutput, 'utf8');
    expect(claudeContent).toMatch(/^<!-- Generated by `condash skills install` /);
    expect(claudeContent).toContain('# Global rules');
    expect(claudeContent).toContain('Use short variable names.');

    // Kimi: plain markdown, same compiled content as Claude (the launcher
    // wraps it into a transient agent-file at spawn).
    const kimiContent = await readKimiContent(kimiAgentOutput);
    expect(kimiContent).toMatch(/^<!-- Generated by `condash skills install` /);
    expect(kimiContent).toContain('# Global rules');
  });

  it('splices per-agent fragments before ## Specifics', async () => {
    await writeAgentConfig({
      common: '# Title\n\n## General\n\nShared.\n\n## Specifics\n\nMore.\n',
      claude: '### Claude\n\n- Claude rule.\n',
      kimi: '### Kimi\n\n- Kimi rule.\n',
    });
    await install();
    const claudeContent = await fs.readFile(claudeAgentOutput, 'utf8');
    const kimiContent = await readKimiContent(kimiAgentOutput);
    expect(claudeContent).toContain('### Claude');
    expect(claudeContent).not.toContain('### Kimi');
    expect(claudeContent.indexOf('### Claude')).toBeLessThan(claudeContent.indexOf('## Specifics'));
    expect(kimiContent).toContain('### Kimi');
    expect(kimiContent).not.toContain('### Claude');
  });

  it('substitutes per-target variables in compiled output', async () => {
    await writeAgentConfig({
      common: 'Skills live at {{ skills_dir }}. Config is {{ agent_config }}.\n',
    });
    await install();
    const claudeContent = await fs.readFile(claudeAgentOutput, 'utf8');
    const kimiContent = await readKimiContent(kimiAgentOutput);
    expect(claudeContent).toContain('Skills live at .claude/skills/. Config is CLAUDE.md.');
    expect(kimiContent).toContain('Skills live at .kimi/skills/. Config is AGENTS.md.');
  });

  it('regenerates outputs on every install (idempotent)', async () => {
    await writeAgentConfig({ common: '# v1\n' });
    await install();
    const v1Claude = await fs.readFile(claudeAgentOutput, 'utf8');
    const v1Kimi = await readKimiContent(kimiAgentOutput);
    await install();
    expect(await fs.readFile(claudeAgentOutput, 'utf8')).toBe(v1Claude);
    expect(await readKimiContent(kimiAgentOutput)).toBe(v1Kimi);

    // User edits Claude target directly; install overwrites.
    await fs.writeFile(claudeAgentOutput, 'tampered\n');
    await install();
    expect(await fs.readFile(claudeAgentOutput, 'utf8')).toBe(v1Claude);
  });

  it('Kimi: writes plain markdown (not a baked agent-file YAML)', async () => {
    await writeAgentConfig({ common: '# Hi\n' });
    await install();
    const raw = await fs.readFile(kimiAgentOutput, 'utf8');
    expect(raw).toMatch(/^<!-- Generated by `condash skills install` /);
    expect(raw).toContain('# Hi');
    // No YAML wrapping — the kimi launcher adds ROLE_ADDITIONAL at spawn.
    expect(raw).not.toContain('ROLE_ADDITIONAL');
    expect(raw).not.toContain('extend: default');
  });

  it('--dry-run reports compile rows without writing outputs', async () => {
    await writeAgentConfig({ common: '# Hi\n' });
    type Env = {
      data: { agentConfigs: { compiled: { target: string; path: string }[] } };
    };
    const env = await captureJson<Env>(() =>
      runSkills(
        'install',
        {
          noun: 'skills',
          verb: 'install',
          positional: [],
          flags: { user: true, 'dry-run': true },
        },
        ctx(),
      ),
    );
    expect(env.data.agentConfigs.compiled).toHaveLength(3);
    await expect(fs.access(claudeAgentOutput)).rejects.toThrow();
    await expect(fs.access(kimiAgentOutput)).rejects.toThrow();
    await expect(fs.access(opencodeAgentOutput)).rejects.toThrow();
  });

  it('status reports ok / stale / missing for agent configs', async () => {
    await writeAgentConfig({ common: 'shared\n', claude: 'claude-only\n', kimi: 'kimi-only\n' });
    await install();

    type StatusEnv = {
      data: {
        items: { kind: string; target?: string; state: string }[];
      };
    };

    let env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    const agentRows = env.data.items.filter((r) => r.kind === 'agent-config');
    expect(agentRows).toHaveLength(3);
    expect(agentRows.every((r) => r.state === 'ok')).toBe(true);

    // Tamper one.
    await fs.writeFile(claudeAgentOutput, 'tampered\n');
    env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    const claudeRow = env.data.items.find(
      (r) => r.kind === 'agent-config' && r.target === 'claude',
    );
    expect(claudeRow?.state).toBe('stale');

    // Remove the other.
    await fs.unlink(kimiAgentOutput);
    env = await captureJson<StatusEnv>(() =>
      runSkills(
        'status',
        { noun: 'skills', verb: 'status', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    const kimiRow = env.data.items.find((r) => r.kind === 'agent-config' && r.target === 'kimi');
    expect(kimiRow?.state).toBe('missing');
  });

  it('list reports the agent-config source + outputs when common.md exists', async () => {
    await writeAgentConfig({ common: '# hi\n' });
    type ListEnv = {
      data: {
        agentConfigs: {
          source: string;
          present: boolean;
          outputs: { claude: string; kimi: string };
        };
      };
    };
    const env = await captureJson<ListEnv>(() =>
      runSkills(
        'list',
        { noun: 'skills', verb: 'list', positional: [], flags: { user: true } },
        ctx(),
      ),
    );
    expect(env.data.agentConfigs.present).toBe(true);
    expect(env.data.agentConfigs.source).toBe(agentConfigRoot);
    expect(env.data.agentConfigs.outputs.claude).toBe(claudeAgentOutput);
    expect(env.data.agentConfigs.outputs.kimi).toBe(kimiAgentOutput);
  });

  it('compiled output embeds the configured source path in the header', async () => {
    await writeAgentConfig({ common: '# hi\n' });
    await install();
    const compiled = await fs.readFile(claudeAgentOutput, 'utf8');
    expect(compiled).toContain(`from ${agentConfigRoot} `);
  });
});
