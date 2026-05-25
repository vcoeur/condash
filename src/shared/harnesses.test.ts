import { describe, expect, it } from 'vitest';
import { AGENTS_MD_OUTPUTS } from '../agents-md/compile';
import { COMPILE_TARGETS } from '../skillspec/types';
import {
  type AgentDef,
  type ClaudeAgentConfig,
  buildSpawn,
  COMPILE_HARNESS_IDS,
  defaultAgentsconfConfig,
  defaultClaudeConfig,
  defaultKimiConfig,
  defaultOpencodeConfig,
  HARNESS_IDS,
  HARNESSES,
  isBuiltinOpencodeAgent,
  isBuiltinPrimaryOpencodeAgent,
  isHarnessId,
  isValidSlug,
  kimiAgentFileYaml,
  MissingAgentSecretError,
  previewCommandLine,
  slugify,
  suggestSlug,
} from './harnesses';

const resolve = (env: Record<string, string>) => (name: string) => env[name] || undefined;

// A claude-on-deepseek config — the alt-provider remap the buildSpawn tests
// assert against (previously sourced from the now-removed CLAUDE_PRESETS).
const deepseekConfig: ClaudeAgentConfig = {
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

describe('harness registry: launch vs compile decoupled', () => {
  it('compile targets are the compile-capable subset — no agentsconf', () => {
    expect([...COMPILE_TARGETS]).toEqual([...COMPILE_HARNESS_IDS]);
    expect(COMPILE_TARGETS).not.toContain('agentsconf');
    for (const id of COMPILE_TARGETS) {
      expect(AGENTS_MD_OUTPUTS[id]).toBe(HARNESSES[id].agentsMdOutput);
    }
  });

  it('agentsconf is a launchable harness with no compile output', () => {
    expect(HARNESS_IDS).toContain('agentsconf');
    expect(isHarnessId('agentsconf')).toBe(true);
    expect(HARNESSES.agentsconf.agentsMdOutput).toBeUndefined();
    expect(HARNESSES.agentsconf.skillsOutputDir).toBeUndefined();
  });
});

describe('slug helpers', () => {
  it('slugify reduces free text to lowercase-kebab', () => {
    expect(slugify('DeepSeek Auto')).toBe('deepseek-auto');
    expect(slugify('  Kimi  K2.6 ')).toBe('kimi-k2-6');
    expect(slugify('a---b__c')).toBe('a-b-c');
    expect(slugify('!!!')).toBe('');
  });

  it('isValidSlug accepts lowercase-kebab and rejects spaces / case / edges', () => {
    expect(isValidSlug('claude-deepseek-v4-pro')).toBe(true);
    expect(isValidSlug('k2')).toBe(true);
    expect(isValidSlug('DeepSeek Auto')).toBe(false);
    expect(isValidSlug('Claude')).toBe(false);
    expect(isValidSlug('a--b')).toBe(false);
    expect(isValidSlug('-x')).toBe(false);
    expect(isValidSlug('a.b')).toBe(false);
    expect(isValidSlug('')).toBe(false);
  });

  it('suggestSlug prefixes the harness label (kimi → kimi-cli)', () => {
    expect(suggestSlug('claude', 'deepseek-v4-pro')).toBe('claude-deepseek-v4-pro');
    expect(suggestSlug('kimi', 'native')).toBe('kimi-cli-native');
    expect(suggestSlug('opencode', 'DeepSeek Auto')).toBe('opencode-deepseek-auto');
    expect(suggestSlug('agentsconf', 'DeepSeek Auto')).toBe('agentsconf-deepseek-auto');
  });
});

describe('buildSpawn — agentsconf', () => {
  const def: AgentDef = {
    harness: 'agentsconf',
    name: 'deepseek-auto',
    slug: 'agentsconf-deepseek-auto',
    config: { binary: 'claude-deepseek-auto' },
  };

  it('runs the bare binary for a terminal (no prompt), with no env or unsets', () => {
    const spec = buildSpawn(def, resolve({}));
    expect(spec).toEqual({ command: 'claude-deepseek-auto', args: [], env: {}, unsetEnv: [] });
  });

  it('passes a task prompt as --run "<PROMPT>"', () => {
    const spec = buildSpawn(def, resolve({}), 'fix the bug');
    expect(spec.command).toBe('claude-deepseek-auto');
    expect(spec.args).toEqual(['--run', 'fix the bug']);
  });

  it('previewCommandLine shows just the binary (no token, no secret resolution)', () => {
    expect(previewCommandLine(def)).toBe('claude-deepseek-auto');
  });

  it('defaultAgentsconfConfig is an empty binary', () => {
    expect(defaultAgentsconfConfig()).toEqual({ binary: '' });
  });
});

describe('buildSpawn — claude', () => {
  const def: AgentDef = {
    harness: 'claude',
    name: 'deepseek-v4-pro',
    slug: 'claude-deepseek-v4-pro',
    secretEnv: 'DEEPSEEK_API_KEY',
    config: deepseekConfig,
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
      name: 'native',
      slug: 'claude-native',
      config: defaultClaudeConfig(),
    };
    const spec = buildSpawn(native, resolve({}));
    expect(spec).toEqual({ command: 'claude', args: [], env: {}, unsetEnv: [] });
  });

  it('appends initialPrompt as a positional argument', () => {
    const spec = buildSpawn(def, resolve({ DEEPSEEK_API_KEY: 'sk-test' }), 'fix the bug');
    expect(spec.args).toEqual(['fix the bug']);
    // Native path also works.
    const native: AgentDef = {
      harness: 'claude',
      name: 'native',
      slug: 'claude-native',
      config: defaultClaudeConfig(),
    };
    const nativeSpec = buildSpawn(native, resolve({}), 'review PR');
    expect(nativeSpec.args).toEqual(['review PR']);
  });
});

describe('buildSpawn — kimi-cli', () => {
  it('spawns bare kimi — the --agent-file is injected at launch, not by the pure builder', () => {
    const def: AgentDef = {
      harness: 'kimi',
      name: 'native',
      slug: 'kimi-cli-native',
      config: defaultKimiConfig(),
    };
    const spec = buildSpawn(def, resolve({}));
    expect(spec.command).toBe('kimi');
    expect(spec.args).toEqual([]);
  });

  it('wraps instructions into an agent-file YAML (ROLE_ADDITIONAL)', () => {
    const yaml = kimiAgentFileYaml('# Instructions\nline two');
    expect(yaml).toContain('ROLE_ADDITIONAL: |');
    expect(yaml).toContain('# Instructions');
    expect(yaml).toContain('extend: default');
  });
});

describe('previewCommandLine', () => {
  it('renders the binary + args with the token as a $ref, never the value', () => {
    const def: AgentDef = {
      harness: 'claude',
      name: 'deepseek-v4-pro',
      slug: 'claude-deepseek-v4-pro',
      secretEnv: 'DEEPSEEK_API_KEY',
      config: deepseekConfig,
    };
    // claude takes no positional args, so the line is just the binary.
    expect(previewCommandLine(def)).toBe('claude');
    // opencode's config rides in env now, so the command line is just the binary.
    expect(
      previewCommandLine({
        harness: 'opencode',
        name: 'deepseek-v4-pro',
        slug: 'opencode-deepseek-v4-pro',
        config: defaultOpencodeConfig('deepseek/deepseek-v4-pro'),
      }),
    ).toBe('opencode');
  });
});

describe('buildSpawn — opencode', () => {
  it('inlines the default model via OPENCODE_CONFIG_CONTENT and disables external skills', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'deepseek-v4-pro',
      slug: 'opencode-deepseek-v4-pro',
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

  it('appends --prompt with initialPrompt', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'deepseek-v4-pro',
      slug: 'opencode-deepseek-v4-pro',
      config: defaultOpencodeConfig('deepseek/deepseek-v4-pro'),
    };
    const spec = buildSpawn(def, resolve({}), 'explain this code');
    expect(spec.args).toEqual(['--prompt', 'explain this code']);
  });

  it('routes per-agent model overrides and merges extra config underneath', () => {
    const spec = buildSpawn(
      {
        harness: 'opencode',
        name: 'deepseek-auto',
        slug: 'opencode-deepseek-auto',
        config: {
          model: 'deepseek/deepseek-v4-flash',
          disableExternalSkills: true,
          agentOptions: [
            { agent: 'build', model: 'deepseek/deepseek-v4-pro' },
            { agent: 'plan', model: 'deepseek/deepseek-v4-pro' },
          ],
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

describe('buildSpawn — kimi ignores initialPrompt', () => {
  it('does not add initialPrompt to args (no interactive support)', () => {
    const def: AgentDef = {
      harness: 'kimi',
      name: 'native',
      slug: 'kimi-cli-native',
      config: defaultKimiConfig(),
    };
    const spec = buildSpawn(def, resolve({}), 'some prompt');
    expect(spec.args).toEqual([]);
  });
});

describe('buildSpawn — opencode/kimi token injection', () => {
  it('exports the declared token under its own var name for opencode', () => {
    const spec = buildSpawn(
      {
        harness: 'opencode',
        name: 'deepseek-v4-pro',
        slug: 'opencode-deepseek-v4-pro',
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
          name: 'x',
          slug: 'opencode-x',
          secretEnv: 'DEEPSEEK_API_KEY',
          config: defaultOpencodeConfig('deepseek/x'),
        },
        resolve({}),
      ),
    ).toThrow(MissingAgentSecretError);
  });
});

describe('buildSpawn — kimi extra flags', () => {
  it('adds --model, --thinking, --plan, and inline --config when set (no --agent-file here)', () => {
    const spec = buildSpawn(
      {
        harness: 'kimi',
        name: 'k2',
        slug: 'kimi-cli-k2',
        config: {
          instructionsFile: '~/.kimi/AGENTS.md',
          model: 'kimi-k2.6',
          thinking: true,
          plan: true,
          configInline: '{"a":1}',
        },
      },
      resolve({}),
    );
    expect(spec.command).toBe('kimi');
    // `--agent-file` is added by the launcher (resolveAgentSpawn), not here.
    expect(spec.args).toEqual([
      '--model',
      'kimi-k2.6',
      '--thinking',
      '--plan',
      '--config',
      '{"a":1}',
    ]);
  });
});

describe('buildSpawn — effort level', () => {
  it('claude emits CLAUDE_CODE_EFFORT_LEVEL when set, omits it when blank', () => {
    const base: AgentDef = {
      harness: 'claude',
      name: 'ds',
      slug: 'claude-ds',
      secretEnv: 'DEEPSEEK_API_KEY',
      config: deepseekConfig,
    };
    expect(buildSpawn(base, resolve({ DEEPSEEK_API_KEY: 'sk' })).env.CLAUDE_CODE_EFFORT_LEVEL).toBe(
      'max',
    );

    const blank: AgentDef = { ...base, config: { ...base.config, effortLevel: '' } };
    expect(buildSpawn(blank, resolve({ DEEPSEEK_API_KEY: 'sk' })).env).not.toHaveProperty(
      'CLAUDE_CODE_EFFORT_LEVEL',
    );
  });
});

describe('buildSpawn — opencode agent options table', () => {
  it('puts the default row on the model base options and only listed agents get their own', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'oc',
      slug: 'opencode-ds',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        defaultOptions: { reasoningEffort: 'low', textVerbosity: 'low' },
        agentOptions: [{ agent: 'plan', reasoningEffort: 'xhigh', reasoningSummary: 'auto' }],
      },
    };
    const cfg = JSON.parse(buildSpawn(def, resolve({})).env.OPENCODE_CONFIG_CONTENT);
    // Default row → the default model's base options (inherited by every agent on it).
    expect(cfg.provider.deepseek.models['deepseek-v4-pro'].options).toEqual({
      reasoningEffort: 'low',
      textVerbosity: 'low',
    });
    // Only plan has its own options; build/general/etc inherit the model base (no agent entry).
    expect(cfg.agent.plan.options).toEqual({ reasoningEffort: 'xhigh', reasoningSummary: 'auto' });
    expect(cfg.agent.build).toBeUndefined();
    expect(cfg.agent.general).toBeUndefined();
  });

  it('gives an agent its own model + options; no model-level options without a default', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'oc',
      slug: 'opencode-ds',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        agentOptions: [
          { agent: 'plan', model: 'kimi-for-coding/kimi-k2-thinking', reasoningEffort: 'high' },
          { agent: 'build', reasoningEffort: 'low' },
        ],
      },
    };
    const cfg = JSON.parse(buildSpawn(def, resolve({})).env.OPENCODE_CONFIG_CONTENT);
    // plan runs kimi at high; build runs the default model at low.
    expect(cfg.agent.plan).toEqual({
      model: 'kimi-for-coding/kimi-k2-thinking',
      options: { reasoningEffort: 'high' },
    });
    expect(cfg.agent.build).toEqual({ options: { reasoningEffort: 'low' } });
    // No default row → no model-level options block at all.
    expect(cfg).not.toHaveProperty('provider');
  });

  it('a per-agent override wins; a model-only row carries the default options onto its model', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'oc',
      slug: 'opencode-ds',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        defaultOptions: { reasoningEffort: 'medium' },
        agentOptions: [
          { agent: 'plan', reasoningEffort: 'low' }, // overrides the model-base medium
          { agent: 'build', model: 'kimi-for-coding/kimi-k2-thinking' }, // carries default medium
        ],
      },
    };
    const cfg = JSON.parse(buildSpawn(def, resolve({})).env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.deepseek.models['deepseek-v4-pro'].options.reasoningEffort).toBe('medium');
    expect(cfg.agent.plan).toEqual({ options: { reasoningEffort: 'low' } });
    expect(cfg.agent.build).toEqual({
      model: 'kimi-for-coding/kimi-k2-thinking',
      options: { reasoningEffort: 'medium' },
    });
  });

  it('emits no options/agents when neither default nor agent rows set anything', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'oc',
      slug: 'opencode-ds',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        agentOptions: [{ agent: 'plan' }],
      },
    };
    const cfg = JSON.parse(buildSpawn(def, resolve({})).env.OPENCODE_CONFIG_CONTENT);
    expect(cfg).not.toHaveProperty('provider');
    expect(cfg).not.toHaveProperty('agent');
  });

  it('a custom row marked primary emits mode:primary — even with no model or options', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'oc',
      slug: 'opencode-ds',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        agentOptions: [
          {
            agent: 'deep',
            primary: true,
            model: 'deepseek/deepseek-v4-pro',
            reasoningEffort: 'xhigh',
          },
          { agent: 'quick', primary: true },
        ],
      },
    };
    const cfg = JSON.parse(buildSpawn(def, resolve({})).env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.agent.deep).toEqual({
      mode: 'primary',
      model: 'deepseek/deepseek-v4-pro',
      options: { reasoningEffort: 'xhigh' },
    });
    // primary alone is enough to emit the entry (it isn't skipped for lacking model/options).
    expect(cfg.agent.quick).toEqual({ mode: 'primary' });
  });

  it('never writes a mode for built-in names, even if primary is set', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'oc',
      slug: 'opencode-ds',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        agentOptions: [
          { agent: 'build', primary: true, reasoningEffort: 'low' },
          { agent: 'plan', primary: true },
        ],
      },
    };
    const cfg = JSON.parse(buildSpawn(def, resolve({})).env.OPENCODE_CONFIG_CONTENT);
    // build keeps its options but no mode override; plan with only primary is skipped entirely.
    expect(cfg.agent.build).toEqual({ options: { reasoningEffort: 'low' } });
    expect(cfg.agent.plan).toBeUndefined();
  });

  it('a custom row that is not primary emits no mode (falls back to opencode default)', () => {
    const def: AgentDef = {
      harness: 'opencode',
      name: 'oc',
      slug: 'opencode-ds',
      config: {
        model: 'deepseek/deepseek-v4-pro',
        disableExternalSkills: true,
        agentOptions: [{ agent: 'helper', primary: false, reasoningEffort: 'low' }],
      },
    };
    const cfg = JSON.parse(buildSpawn(def, resolve({})).env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.agent.helper).toEqual({ options: { reasoningEffort: 'low' } });
    expect(cfg.agent.helper).not.toHaveProperty('mode');
  });
});

describe('opencode built-in agent helpers', () => {
  it('classifies built-in vs custom names', () => {
    expect(isBuiltinOpencodeAgent('build')).toBe(true);
    expect(isBuiltinOpencodeAgent('scout')).toBe(true);
    expect(isBuiltinOpencodeAgent('deep')).toBe(false);
    expect(isBuiltinOpencodeAgent('')).toBe(false);
  });

  it('classifies built-in primaries (build/plan) vs built-in subagents', () => {
    expect(isBuiltinPrimaryOpencodeAgent('build')).toBe(true);
    expect(isBuiltinPrimaryOpencodeAgent('plan')).toBe(true);
    expect(isBuiltinPrimaryOpencodeAgent('general')).toBe(false);
    expect(isBuiltinPrimaryOpencodeAgent('explore')).toBe(false);
    expect(isBuiltinPrimaryOpencodeAgent('deep')).toBe(false);
  });
});
