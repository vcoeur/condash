import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDef, ClaudeAgentConfig } from '../shared/harnesses';
import {
  agentsEnvPath,
  deleteAgent,
  listAgents,
  parseEnv,
  previewAgent,
  readAgent,
  readAgentsEnv,
  resolveAgentSpawn,
  writeAgent,
  writeAgentsEnv,
} from './agents';

// A claude-on-deepseek config (provider remap) — the fixture the spawn/token
// tests need a non-empty baseUrl for. Inlined since CLAUDE_PRESETS was removed.
const deepseekClaudeConfig: ClaudeAgentConfig = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  authStyle: 'bearer',
  model: 'deepseek-v4-pro',
  smallFastModel: 'deepseek-v4-pro',
  haikuAlias: 'deepseek-v4-pro',
  sonnetAlias: 'deepseek-v4-pro',
  opusAlias: 'deepseek-v4-pro',
  subagentModel: 'deepseek-v4-pro',
  maxContextTokens: 1000000,
  effortLevel: 'max',
  disableCaching: false,
  disable1M: true,
  disableAdaptiveThinking: true,
  disableTelemetry: true,
  disableErrorReporting: true,
  disableClaudeApiSkill: true,
};

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'condash-agents-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const claudeAgent: AgentDef = {
  harness: 'claude',
  name: 'deepseek-v4-pro',
  slug: 'claude-deepseek-v4-pro',
  secretEnv: 'DEEPSEEK_API_KEY',
  config: deepseekClaudeConfig,
};

/** Write a raw JSON agent file (bypassing writeAgent) to simulate legacy /
 *  hand-edited files on disk. */
async function writeRaw(filename: string, content: unknown): Promise<void> {
  await fs.mkdir(join(dir, 'agents'), { recursive: true });
  await fs.writeFile(join(dir, 'agents', filename), JSON.stringify(content), 'utf8');
}

describe('parseEnv', () => {
  it('parses KEY=value lines, ignoring comments/blanks and stripping quotes', () => {
    expect(parseEnv('# c\n\nA=1\nB="two"\nC=\nbad line\n')).toEqual({ A: '1', B: 'two', C: '' });
  });
});

describe('agent storage round-trip', () => {
  it('writes <slug>.json and lists it back with name + token presence', async () => {
    const slug = await writeAgent(dir, claudeAgent);
    expect(slug).toBe('claude-deepseek-v4-pro');
    await fs.access(join(dir, 'agents', 'claude-deepseek-v4-pro.json'));

    // No .env yet → token absent.
    let items = await listAgents(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      slug: 'claude-deepseek-v4-pro',
      name: 'deepseek-v4-pro',
      harness: 'claude',
      tokenPresent: false,
    });

    await fs.writeFile(agentsEnvPath(dir), 'DEEPSEEK_API_KEY=sk-real\n');
    items = await listAgents(dir);
    expect(items[0].tokenPresent).toBe(true);

    const def = await readAgent(dir, slug);
    expect(def?.harness).toBe('claude');
    expect(def?.name).toBe('deepseek-v4-pro');
    expect(def?.slug).toBe('claude-deepseek-v4-pro');
  });

  it('rejects a non-kebab slug on write', async () => {
    await expect(writeAgent(dir, { ...claudeAgent, slug: 'Claude DeepSeek' })).rejects.toThrow(
      /invalid agent slug/,
    );
    await expect(writeAgent(dir, { ...claudeAgent, slug: 'a--b' })).rejects.toThrow(
      /invalid agent slug/,
    );
  });

  it('rename via previousSlug removes the old file', async () => {
    await writeAgent(dir, claudeAgent);
    const renamed: AgentDef = {
      ...claudeAgent,
      name: 'deepseek-v4-flash',
      slug: 'claude-deepseek-v4-flash',
    };
    await writeAgent(dir, renamed, 'claude-deepseek-v4-pro');
    const slugs = (await listAgents(dir)).map((a) => a.slug);
    expect(slugs).toEqual(['claude-deepseek-v4-flash']);
  });

  it('re-saving with an unchanged slug does not delete the file', async () => {
    await writeAgent(dir, claudeAgent);
    await writeAgent(dir, { ...claudeAgent, name: 'renamed display' }, 'claude-deepseek-v4-pro');
    const items = await listAgents(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ slug: 'claude-deepseek-v4-pro', name: 'renamed display' });
  });

  it('rejects a rename onto a slug that already holds another agent', async () => {
    await writeAgent(dir, { ...claudeAgent, name: 'keep', slug: 'claude-keep' });
    await writeAgent(dir, { ...claudeAgent, name: 'rename me', slug: 'claude-rename-me' });
    await expect(
      writeAgent(dir, { ...claudeAgent, slug: 'claude-keep' }, 'claude-rename-me'),
    ).rejects.toThrow(/already exists/);
    // Both survive: the target was not clobbered and the source was not deleted.
    const slugs = (await listAgents(dir)).map((a) => a.slug).sort();
    expect(slugs).toEqual(['claude-keep', 'claude-rename-me']);
  });

  it('deleteAgent is idempotent', async () => {
    await writeAgent(dir, claudeAgent);
    await deleteAgent(dir, 'claude-deepseek-v4-pro');
    await deleteAgent(dir, 'claude-deepseek-v4-pro');
    expect(await listAgents(dir)).toEqual([]);
  });

  it('listAgents returns [] when the agents dir is absent', async () => {
    expect(await listAgents(dir)).toEqual([]);
  });
});

describe('legacy + space-named files', () => {
  it('launches a legacy agent whose filename contains a space (regression)', async () => {
    // Pre-name/slug shape, space in the filename — the old safeName rejected
    // this on launch with "invalid agent name".
    await writeRaw('opencode-DeepSeek Auto.json', {
      harness: 'opencode',
      modelVariant: 'DeepSeek Auto',
      config: { model: 'deepseek/deepseek-v4-flash', disableExternalSkills: true },
    });

    const items = await listAgents(dir);
    expect(items[0]).toMatchObject({
      slug: 'opencode-DeepSeek Auto',
      name: 'DeepSeek Auto',
      harness: 'opencode',
    });

    // The bug: this used to throw before resolving. Now it spawns.
    const spec = await resolveAgentSpawn(dir, 'opencode-DeepSeek Auto');
    expect(spec.command).toBe('opencode');
  });

  it('normalises legacy modelVariant → name and slug = filename stem', async () => {
    await writeRaw('claude-legacy.json', {
      harness: 'claude',
      modelVariant: 'legacy-label',
      secretEnv: 'DEEPSEEK_API_KEY',
      config: deepseekClaudeConfig,
    });
    const def = await readAgent(dir, 'claude-legacy');
    expect(def?.name).toBe('legacy-label');
    expect(def?.slug).toBe('claude-legacy');
  });

  it('migrates a legacy/space file to a clean slug on re-save', async () => {
    await writeRaw('opencode-DeepSeek Auto.json', {
      harness: 'opencode',
      modelVariant: 'DeepSeek Auto',
      config: { model: 'deepseek/deepseek-v4-flash', disableExternalSkills: true },
    });
    const def = await readAgent(dir, 'opencode-DeepSeek Auto');
    expect(def).toBeTruthy();
    await writeAgent(dir, { ...def!, slug: 'opencode-deepseek-auto' }, 'opencode-DeepSeek Auto');
    const slugs = (await listAgents(dir)).map((a) => a.slug);
    expect(slugs).toEqual(['opencode-deepseek-auto']);
  });
});

describe('opencode build/plan persistence', () => {
  it('round-trips per-agent model overrides + extra config through write → read', async () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'deepseek-auto',
      slug: 'opencode-deepseek-auto',
      secretEnv: 'DEEPSEEK_API_KEY',
      config: {
        model: 'deepseek/deepseek-v4-flash',
        disableExternalSkills: true,
        agentOptions: [
          { agent: 'build', model: 'deepseek/deepseek-v4-pro' },
          { agent: 'plan', model: 'deepseek/deepseek-v4-pro' },
        ],
        extraConfigJson: '{"theme":"tokyonight"}',
      },
    };
    await writeAgent(dir, def);
    const back = await readAgent(dir, 'opencode-deepseek-auto');
    expect(back).toEqual(def);
  });

  it('drops retired keys and loads an opencode agent without the options-table fields', async () => {
    // A file carrying any retired key (effortLevel/reasoningOverrides/variants/
    // defaultVariant/agentOverrides) still loads; unknown keys are stripped and
    // the current fields are absent.
    await writeRaw('opencode-legacy.json', {
      harness: 'opencode',
      name: 'legacy',
      slug: 'opencode-legacy',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        effortLevel: 'max',
        variants: [{ name: 'deep', reasoningEffort: 'high' }],
        defaultVariant: 'deep',
        agentOverrides: [{ agent: 'plan', variant: 'deep' }],
      },
    });
    const back = await readAgent(dir, 'opencode-legacy');
    expect(back?.harness).toBe('opencode');
    const cfg = back?.config as Record<string, unknown>;
    expect(cfg.effortLevel).toBeUndefined();
    expect(cfg.variants).toBeUndefined();
    expect(cfg.defaultVariant).toBeUndefined();
    expect(cfg.agentOverrides).toBeUndefined();
    expect(cfg.defaultOptions).toBeUndefined();
    expect(cfg.agentOptions).toBeUndefined();
  });

  it('round-trips the agent options table (default + per-agent model/effort)', async () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'deepseek-pro',
      slug: 'opencode-deepseek-v4-pro',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        defaultOptions: { reasoningEffort: 'medium', textVerbosity: 'low' },
        agentOptions: [
          { agent: 'plan', model: 'kimi-for-coding/kimi-k2-thinking', reasoningEffort: 'high' },
          { agent: 'build', reasoningEffort: 'low' },
        ],
      },
    };
    await writeAgent(dir, def);
    const back = await readAgent(dir, 'opencode-deepseek-v4-pro');
    expect(back).toEqual(def);
  });

  it('round-trips a custom primary agent row', async () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'deepseek-primaries',
      slug: 'opencode-deepseek-primaries',
      config: {
        model: 'deepseek/deepseek-v4-flash',
        disableExternalSkills: true,
        agentOptions: [
          {
            agent: 'deep',
            primary: true,
            model: 'deepseek/deepseek-v4-pro',
            reasoningEffort: 'high',
          },
          { agent: 'helper', primary: false, reasoningEffort: 'low' },
        ],
      },
    };
    await writeAgent(dir, def);
    const back = await readAgent(dir, 'opencode-deepseek-primaries');
    expect(back).toEqual(def);
  });
});

describe('agentsconf harness', () => {
  const agentsconfAgent: AgentDef = {
    harness: 'agentsconf',
    name: 'deepseek-auto',
    slug: 'agentsconf-deepseek-auto',
    config: { binary: 'claude-deepseek-auto' },
  };

  it('round-trips write → read and lists with no token required', async () => {
    await writeAgent(dir, agentsconfAgent);
    const items = await listAgents(dir);
    expect(items[0]).toMatchObject({
      slug: 'agentsconf-deepseek-auto',
      name: 'deepseek-auto',
      harness: 'agentsconf',
      command: 'claude-deepseek-auto',
      // No secretEnv → tokenPresent is vacuously true.
      tokenPresent: true,
    });
    const back = await readAgent(dir, 'agentsconf-deepseek-auto');
    expect(back).toEqual(agentsconfAgent);
  });

  it('resolveAgentSpawn runs the bare binary; with a prompt it adds --run', async () => {
    await writeAgent(dir, agentsconfAgent);
    const bare = await resolveAgentSpawn(dir, 'agentsconf-deepseek-auto');
    expect(bare).toEqual({ command: 'claude-deepseek-auto', args: [], env: {}, unsetEnv: [] });
    const task = await resolveAgentSpawn(dir, 'agentsconf-deepseek-auto', 'fix the bug');
    expect(task.args).toEqual(['--run', 'fix the bug']);
  });
});

describe('kimi instructions injection', () => {
  it('wraps instructionsFile into a transient --agent-file at spawn', async () => {
    const mdPath = join(dir, 'kimi-instructions.md');
    await fs.writeFile(mdPath, '# Rules\nbe nice');
    await writeAgent(dir, {
      harness: 'kimi',
      name: 'native',
      slug: 'kimi-cli-native',
      config: { instructionsFile: mdPath, model: 'kimi-k2.6' },
    });
    const spec = await resolveAgentSpawn(dir, 'kimi-cli-native');
    expect(spec.command).toBe('kimi');
    expect(spec.args[0]).toBe('--agent-file');
    const generated = await fs.readFile(spec.args[1], 'utf8');
    expect(generated).toContain('ROLE_ADDITIONAL: |');
    expect(generated).toContain('be nice');
    expect(spec.args).toContain('--model'); // flags still follow the injected agent-file
  });

  it('omits --agent-file when the instructions file is absent', async () => {
    await writeAgent(dir, {
      harness: 'kimi',
      name: 'native',
      slug: 'kimi-cli-native',
      config: { instructionsFile: join(dir, 'missing.md') },
    });
    const spec = await resolveAgentSpawn(dir, 'kimi-cli-native');
    expect(spec.args).not.toContain('--agent-file');
  });
});

describe('agents/.env editor', () => {
  it('returns a commented template when absent, then round-trips writes', async () => {
    expect(await readAgentsEnv(dir)).toContain('agents/.env');
    await writeAgentsEnv(dir, 'DEEPSEEK_API_KEY=sk-real\n');
    expect(await readAgentsEnv(dir)).toBe('DEEPSEEK_API_KEY=sk-real\n');
    // And the written value drives token presence.
    await writeAgent(dir, claudeAgent);
    expect((await listAgents(dir))[0].tokenPresent).toBe(true);
  });
});

describe('resolveAgentSpawn', () => {
  it('injects the real token from agents/.env', async () => {
    await writeAgent(dir, claudeAgent);
    await fs.writeFile(agentsEnvPath(dir), 'DEEPSEEK_API_KEY=sk-real\n');
    const spec = await resolveAgentSpawn(dir, 'claude-deepseek-v4-pro');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-real');
  });

  it('throws when the token is missing', async () => {
    await writeAgent(dir, claudeAgent);
    await expect(resolveAgentSpawn(dir, 'claude-deepseek-v4-pro')).rejects.toThrow(
      /DEEPSEEK_API_KEY/,
    );
  });
});

describe('previewAgent', () => {
  it('masks the token as a $SECRET_ENV reference', async () => {
    await writeAgent(dir, claudeAgent);
    await fs.writeFile(agentsEnvPath(dir), 'DEEPSEEK_API_KEY=sk-real\n');
    const preview = await previewAgent(dir, 'claude-deepseek-v4-pro');
    expect(preview?.env.ANTHROPIC_AUTH_TOKEN).toBe('$DEEPSEEK_API_KEY');
    expect(JSON.stringify(preview)).not.toContain('sk-real');
  });
});
