import { describe, expect, it } from 'vitest';
import { compileAgentConfig } from './compile';

describe('compileAgentConfig — fragment insertion', () => {
  it('inserts fragment before ## Specifics', () => {
    const common = '# Title\n\n## General\n\nContent.\n\n## Specifics\n\nSpecific content.\n';
    const fragment = '### Claude\n\n- Claude-only rule.\n';
    const out = compileAgentConfig(common, fragment, 'claude');
    expect(out).toContain('## General');
    expect(out).toContain('### Claude');
    expect(out.indexOf('### Claude')).toBeLessThan(out.indexOf('## Specifics'));
    expect(out).toContain('Specific content.');
  });

  it('appends fragment when ## Specifics is missing', () => {
    const common = '# Title\n\n## General\n\nContent.\n';
    const fragment = '### Kimi\n\n- Kimi-only rule.\n';
    const out = compileAgentConfig(common, fragment, 'kimi');
    expect(out).toContain('### Kimi');
    expect(out.indexOf('Content.')).toBeLessThan(out.indexOf('### Kimi'));
  });

  it('returns common unchanged when fragment is empty', () => {
    const common = '# Title\n\n## Specifics\n\nContent.\n';
    const out = compileAgentConfig(common, '', 'claude');
    expect(out).toBe('# Title\n\n## Specifics\n\nContent.\n');
  });

  it('returns common unchanged when fragment is whitespace-only', () => {
    const common = '# Title\n\n## Specifics\n\nContent.\n';
    const out = compileAgentConfig(common, '   \n\n  ', 'kimi');
    expect(out).toBe('# Title\n\n## Specifics\n\nContent.\n');
  });
});

describe('compileAgentConfig — variable substitution', () => {
  it('substitutes {{ skills_dir }} per target', () => {
    const common = 'Skills at {{ skills_dir }}.';
    const outClaude = compileAgentConfig(common, '', 'claude');
    const outKimi = compileAgentConfig(common, '', 'kimi');
    expect(outClaude).toBe('Skills at .claude/skills/.');
    expect(outKimi).toBe('Skills at .kimi/skills/.');
  });

  it('substitutes {{ agent_config }} per target', () => {
    const common = 'Config is {{ agent_config }}.';
    expect(compileAgentConfig(common, '', 'claude')).toBe('Config is CLAUDE.md.');
    expect(compileAgentConfig(common, '', 'kimi')).toBe('Config is AGENTS.md.');
  });

  it('replaces unknown variables with empty string', () => {
    expect(compileAgentConfig('Hello {{ unknown }}.', '', 'claude')).toBe('Hello .');
  });

  it('substitutes {{ memory_dir }} per target', () => {
    const common = 'Memory at {{ memory_dir }}.';
    expect(compileAgentConfig(common, '', 'kimi')).toBe('Memory at .');
    expect(compileAgentConfig(common, '', 'claude')).toContain('~/.claude/projects/');
  });

  it('allows variable overrides', () => {
    const out = compileAgentConfig('{{ skills_dir }}', '', 'claude', {
      variables: { skills_dir: 'custom/' },
    });
    expect(out).toBe('custom/');
  });
});
