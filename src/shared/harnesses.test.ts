import { describe, expect, it } from 'vitest';
import { AGENTS_MD_OUTPUTS } from '../agents-md/compile';
import { COMPILE_TARGETS } from '../skillspec/types';
import {
  type AgentDef,
  agentName,
  buildSpawn,
  CLAUDE_PRESETS,
  defaultKimiConfig,
  defaultOpencodeConfig,
  HARNESS_IDS,
  HARNESSES,
  MissingAgentSecretError,
  previewCommandLine,
} from './harnesses';

const resolve = (env: Record<string, string>) => (name: string) => env[name] || undefined;

describe('harness registry is the single source of truth', () => {
  it('drives the skills + AGENTS.md compile targets', () => {
    expect([...COMPILE_TARGETS]).toEqual([...HARNESS_IDS]);
    for (const id of HARNESS_IDS) {
      expect(AGENTS_MD_OUTPUTS[id]).toBe(HARNESSES[id].agentsMdOutput);
    }
  });
});

describe('agentName', () => {
  it('derives <label>-<modelVariant>, using the CLI label (kimi-cli)', () => {
    expect(agentName({ harness: 'claude', modelVariant: 'deepseek-v4-pro' })).toBe(
      'claude-deepseek-v4-pro',
    );
    expect(agentName({ harness: 'kimi', modelVariant: 'native' })).toBe('kimi-cli-native');
    expect(agentName({ harness: 'opencode', modelVariant: 'deepseek-v4-pro' })).toBe(
      'opencode-deepseek-v4-pro',
    );
  });
});

describe('buildSpawn — claude', () => {
  const def: AgentDef = {
    harness: 'claude',
    modelVariant: 'deepseek-v4-pro',
    secretEnv: 'DEEPSEEK_API_KEY',
    config: CLAUDE_PRESETS['deepseek-v4-pro'].config,
  };

  it('builds the ANTHROPIC_* env with a bearer token and defensive unsets', () => {
    const spec = buildSpawn(def, resolve({ DEEPSEEK_API_KEY: 'sk-test' }));
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual([]);
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    expect(spec.env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro');
    expect(spec.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
    expect(spec.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
    expect(spec.unsetEnv).toContain('ANTHROPIC_API_KEY');
    expect(spec.unsetEnv).toEqual(expect.arrayContaining(['CLAUDE_CODE_USE_BEDROCK']));
  });

  it('uses x-api-key style when authStyle is apikey', () => {
    const apikeyDef: AgentDef = {
      ...def,
      config: { ...def.config, authStyle: 'apikey' },
    };
    const spec = buildSpawn(apikeyDef, resolve({ DEEPSEEK_API_KEY: 'sk-test' }));
    expect(spec.env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(spec.unsetEnv).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('throws MissingAgentSecretError when the declared secret is unset', () => {
    expect(() => buildSpawn(def, resolve({}))).toThrow(MissingAgentSecretError);
  });

  it('native (empty baseUrl) runs bare claude with no env or unsets', () => {
    const native: AgentDef = {
      harness: 'claude',
      modelVariant: 'native',
      config: CLAUDE_PRESETS.native.config,
    };
    const spec = buildSpawn(native, resolve({}));
    expect(spec).toEqual({ command: 'claude', args: [], env: {}, unsetEnv: [] });
  });
});

describe('buildSpawn — kimi-cli', () => {
  it('points kimi at its --agent-file YAML', () => {
    const def: AgentDef = { harness: 'kimi', modelVariant: 'native', config: defaultKimiConfig() };
    const spec = buildSpawn(def, resolve({}));
    expect(spec.command).toBe('kimi');
    expect(spec.args).toEqual(['--agent-file', '~/.kimi/global-agent.yaml']);
  });
});

describe('previewCommandLine', () => {
  it('renders the binary + args with the token as a $ref, never the value', () => {
    const def: AgentDef = {
      harness: 'claude',
      modelVariant: 'deepseek-v4-pro',
      secretEnv: 'DEEPSEEK_API_KEY',
      config: CLAUDE_PRESETS['deepseek-v4-pro'].config,
    };
    // claude takes no positional args, so the line is just the binary.
    expect(previewCommandLine(def)).toBe('claude');
    // opencode's config rides in env now, so the command line is just the binary.
    expect(
      previewCommandLine({
        harness: 'opencode',
        modelVariant: 'deepseek-v4-pro',
        config: defaultOpencodeConfig('deepseek/deepseek-v4-pro'),
      }),
    ).toBe('opencode');
  });
});

describe('buildSpawn — opencode', () => {
  it('inlines the default model via OPENCODE_CONFIG_CONTENT and disables external skills', () => {
    const def: AgentDef = {
      harness: 'opencode',
      modelVariant: 'deepseek-v4-pro',
      config: defaultOpencodeConfig('deepseek/deepseek-v4-pro'),
    };
    const spec = buildSpawn(def, resolve({}));
    expect(spec.command).toBe('opencode');
    expect(spec.args).toEqual([]);
    expect(spec.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');
    expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'deepseek/deepseek-v4-pro',
    });
  });

  it('routes build/plan overrides and merges extra config underneath', () => {
    const spec = buildSpawn(
      {
        harness: 'opencode',
        modelVariant: 'deepseek-auto',
        config: {
          model: 'deepseek/deepseek-v4-flash',
          buildModel: 'deepseek/deepseek-v4-pro',
          planModel: 'deepseek/deepseek-v4-pro',
          disableExternalSkills: true,
          extraConfigJson: '{ "theme": "tokyonight" }',
        },
      },
      resolve({}),
    );
    expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      theme: 'tokyonight',
      model: 'deepseek/deepseek-v4-flash',
      agent: {
        build: { model: 'deepseek/deepseek-v4-pro' },
        plan: { model: 'deepseek/deepseek-v4-pro' },
      },
    });
  });
});

describe('buildSpawn — opencode/kimi token injection', () => {
  it('exports the declared token under its own var name for opencode', () => {
    const spec = buildSpawn(
      {
        harness: 'opencode',
        modelVariant: 'deepseek-v4-pro',
        secretEnv: 'DEEPSEEK_API_KEY',
        config: defaultOpencodeConfig('deepseek/deepseek-v4-pro'),
      },
      resolve({ DEEPSEEK_API_KEY: 'sk-real' }),
    );
    expect(spec.env.DEEPSEEK_API_KEY).toBe('sk-real');
  });

  it('throws when an opencode/kimi agent declares a missing token', () => {
    expect(() =>
      buildSpawn(
        {
          harness: 'opencode',
          modelVariant: 'x',
          secretEnv: 'DEEPSEEK_API_KEY',
          config: defaultOpencodeConfig('deepseek/x'),
        },
        resolve({}),
      ),
    ).toThrow(MissingAgentSecretError);
  });
});

describe('buildSpawn — kimi extra flags', () => {
  it('adds --model, --thinking, --plan, and inline --config when set', () => {
    const spec = buildSpawn(
      {
        harness: 'kimi',
        modelVariant: 'k2',
        config: {
          agentFile: '~/.kimi/global-agent.yaml',
          model: 'kimi-k2.6',
          thinking: true,
          plan: true,
          configInline: '{"a":1}',
        },
      },
      resolve({}),
    );
    expect(spec.command).toBe('kimi');
    expect(spec.args).toEqual([
      '--agent-file',
      '~/.kimi/global-agent.yaml',
      '--model',
      'kimi-k2.6',
      '--thinking',
      '--plan',
      '--config',
      '{"a":1}',
    ]);
  });
});
