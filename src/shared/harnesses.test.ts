import { describe, expect, it } from 'vitest';
import { AGENTS_MD_OUTPUTS } from '../agents-md/compile';
import { COMPILE_TARGETS } from '../skillspec/types';
import {
  type AgentDef,
  buildSpawn,
  CLAUDE_PRESETS,
  defaultKimiConfig,
  defaultOpencodeConfig,
  HARNESS_IDS,
  HARNESSES,
  isValidSlug,
  kimiAgentFileYaml,
  MissingAgentSecretError,
  previewCommandLine,
  slugify,
  suggestSlug,
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
  });
});

describe('buildSpawn — claude', () => {
  const def: AgentDef = {
    harness: 'claude',
    name: 'deepseek-v4-pro',
    slug: 'claude-deepseek-v4-pro',
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
      name: 'native',
      slug: 'claude-native',
      config: CLAUDE_PRESETS.native.config,
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
      config: CLAUDE_PRESETS.native.config,
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
      config: CLAUDE_PRESETS['deepseek-v4-pro'].config,
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
      config: CLAUDE_PRESETS['deepseek-v4-pro'].config,
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
  it('derives effort-named variants + per-agent variant from default + agent rows', () => {
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
    const m = cfg.provider.deepseek.models['deepseek-v4-pro'];
    // One variant per distinct effort, named by the effort.
    expect(m.variants.low).toEqual({ reasoningEffort: 'low', textVerbosity: 'low' });
    expect(m.variants.xhigh).toEqual({ reasoningEffort: 'xhigh', reasoningSummary: 'auto' });
    // Default effort (low) on every agent except plan (xhigh); model pinned.
    expect(cfg.agent.plan).toEqual({ variant: 'xhigh', model: 'deepseek/deepseek-v4-pro' });
    for (const name of ['build', 'general', 'explore', 'scout']) {
      expect(cfg.agent[name]).toEqual({ variant: 'low', model: 'deepseek/deepseek-v4-pro' });
    }
  });

  it('gives an agent its own model + effort, emitting the variant on that model too', () => {
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
    expect(cfg.agent.plan).toEqual({ model: 'kimi-for-coding/kimi-k2-thinking', variant: 'high' });
    expect(cfg.agent.build).toEqual({ variant: 'low', model: 'deepseek/deepseek-v4-pro' });
    // 'high' variant is emitted on the kimi model so plan resolves it.
    expect(
      cfg.provider['kimi-for-coding'].models['kimi-k2-thinking'].variants.high.reasoningEffort,
    ).toBe('high');
    // 'low' variant on the default deepseek model for build.
    expect(cfg.provider.deepseek.models['deepseek-v4-pro'].variants.low.reasoningEffort).toBe(
      'low',
    );
  });

  it('emits no variants/agents when neither default nor agent rows set an effort', () => {
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
});
