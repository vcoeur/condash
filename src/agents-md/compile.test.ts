import { describe, expect, it } from 'vitest';
import { compileAgentsMd } from './compile';

describe('compileAgentsMd — section stripping', () => {
  it('keeps the matching ### Claude section for the claude target', () => {
    const source = [
      '# AGENTS',
      '',
      'Common preamble.',
      '',
      '### Claude',
      '',
      '- Claude-only rule.',
      '',
      '### Kimi',
      '',
      '- Kimi-only rule.',
      '',
      '## Next H2',
      '',
      'After.',
      '',
    ].join('\n');
    const out = compileAgentsMd(source, 'claude');
    expect(out).toContain('Claude-only rule');
    expect(out).not.toContain('Kimi-only rule');
    expect(out).toContain('After.');
  });

  it('keeps the matching ### Kimi section for the kimi target', () => {
    const source = '## A\n\n### Claude\n\nC\n\n### Kimi\n\nK\n\n## B\n';
    const out = compileAgentsMd(source, 'kimi');
    expect(out).not.toContain('\nC\n');
    expect(out).toContain('\nK\n');
  });

  it('strips off-target section ending at end of file', () => {
    const source = '## A\n\nbody\n\n### Claude\n\nclaude only\n';
    const out = compileAgentsMd(source, 'kimi');
    expect(out).not.toContain('claude only');
    expect(out.trim()).toBe('## A\n\nbody'.trim());
  });

  it('does not collapse non-target H3 headings', () => {
    const source = '## A\n\n### Subsection\n\nBoth see this.\n\n### Claude\n\nClaude only.\n';
    const out = compileAgentsMd(source, 'kimi');
    expect(out).toContain('### Subsection');
    expect(out).toContain('Both see this.');
    expect(out).not.toContain('Claude only.');
  });

  it('strips the off-target H3 even when followed by another H3', () => {
    const source = '## A\n\n### Kimi\n\nKimi only.\n\n### Notes\n\nShared notes.\n';
    const out = compileAgentsMd(source, 'claude');
    expect(out).not.toContain('Kimi only.');
    expect(out).toContain('### Notes');
    expect(out).toContain('Shared notes.');
  });

  it('does not leave a double-blank seam where a section was removed', () => {
    const source = ['Line 1.', '', '### Kimi', '', 'Strip me.', '', 'Line 2.', ''].join('\n');
    const out = compileAgentsMd(source, 'claude');
    expect(out).not.toContain('\n\n\n');
  });
});

describe('compileAgentsMd — variable substitution', () => {
  it('substitutes default per-target variables', () => {
    const source = 'Skills live at {{ skills_dir }} and config is {{ agent_config }}.';
    expect(compileAgentsMd(source, 'claude')).toBe(
      'Skills live at .claude/skills/ and config is CLAUDE.md.',
    );
    expect(compileAgentsMd(source, 'kimi')).toBe(
      'Skills live at .kimi/skills/ and config is AGENTS.md.',
    );
  });

  it('replaces unknown variables with the empty string', () => {
    expect(compileAgentsMd('Hello {{ unknown }}.', 'claude')).toBe('Hello .');
  });

  it('substitutes Kimi memory_dir with empty (no native memory)', () => {
    expect(compileAgentsMd('Memory at {{ memory_dir }}.', 'kimi')).toBe('Memory at .');
    expect(compileAgentsMd('Memory at {{ memory_dir }}.', 'claude')).toContain(
      '~/.claude/projects/',
    );
  });

  it('honours a caller-supplied variable map override', () => {
    const out = compileAgentsMd('{{ skills_dir }}', 'claude', {
      variables: { skills_dir: '/tmp/override' },
    });
    expect(out).toBe('/tmp/override');
  });
});
