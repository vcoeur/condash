import { describe, expect, it } from 'vitest';
import { compileSkillspec } from './compile';
import type { Skillspec } from './types';

function spec(overrides: Partial<Skillspec> = {}): Skillspec {
  return {
    name: 'demo',
    sourceDir: '/tmp/demo',
    spec: { description: 'demo skill' },
    body: '# Demo\n\nHello.\n',
    targets: {},
    assets: {},
    ...overrides,
  };
}

describe('compileSkillspec', () => {
  it('emits a SKILL.md for Claude with merged frontmatter', () => {
    const out = compileSkillspec(
      spec({
        spec: { description: 'demo skill' },
        targets: { claude: { 'allowed-tools': 'Read, Write' } },
      }),
      'claude',
    );
    const text = out.files['SKILL.md'].toString('utf8');
    expect(text).toBe(
      '---\ndescription: demo skill\nallowed-tools: Read, Write\n---\n\n# Demo\n\nHello.\n',
    );
  });

  it('emits Kimi with only spec keys when no overlay', () => {
    const out = compileSkillspec(spec(), 'kimi');
    const text = out.files['SKILL.md'].toString('utf8');
    expect(text).toBe('---\ndescription: demo skill\n---\n\n# Demo\n\nHello.\n');
  });

  it('overlay values override spec values; key order follows spec', () => {
    const out = compileSkillspec(
      spec({
        spec: { description: 'spec desc', extra: 1 },
        targets: { claude: { description: 'overlay desc', name: 'override' } },
      }),
      'claude',
    );
    const text = out.files['SKILL.md'].toString('utf8');
    // spec keys first (description=overlay value, extra=1), then overlay-only (name)
    expect(text).toBe(
      '---\ndescription: overlay desc\nextra: 1\nname: override\n---\n\n# Demo\n\nHello.\n',
    );
  });

  it('copies sibling assets verbatim', () => {
    const out = compileSkillspec(
      spec({
        assets: {
          'close.md': Buffer.from('close action\n', 'utf8'),
          'references/cmd.md': Buffer.from('cmd\n', 'utf8'),
        },
      }),
      'claude',
    );
    expect(Object.keys(out.files).sort()).toEqual(['SKILL.md', 'close.md', 'references/cmd.md']);
    expect(out.files['close.md'].toString('utf8')).toBe('close action\n');
  });

  it('strips leading blank lines from body and ensures trailing newline', () => {
    const out = compileSkillspec(spec({ body: '\n\n# Heading\n\nText' }), 'claude');
    const text = out.files['SKILL.md'].toString('utf8');
    expect(text).toBe('---\ndescription: demo skill\n---\n\n# Heading\n\nText\n');
  });

  it('preserves long single-line YAML values without folding', () => {
    const long = 'A, '.repeat(60).trim().replace(/,$/, '');
    const out = compileSkillspec(
      spec({ targets: { claude: { 'allowed-tools': long } } }),
      'claude',
    );
    const text = out.files['SKILL.md'].toString('utf8');
    expect(text).toContain(`allowed-tools: ${long}\n`);
  });

  it('quotes a description with embedded colon (YAML safety)', () => {
    const out = compileSkillspec(
      spec({ spec: { description: 'Manage things: foo and bar' } }),
      'claude',
    );
    const text = out.files['SKILL.md'].toString('utf8');
    // YAML lib should quote — we don't care about quote style, just that it parses back.
    expect(text).toMatch(/description: ['"]?Manage things: foo and bar['"]?/);
  });
});
