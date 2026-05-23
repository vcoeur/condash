import { describe, expect, it } from 'vitest';
import { compileSkillspec } from './compile';
import { decompileSkillMd } from './decompile';
import { SkillspecError } from './parse';
import type { Skillspec } from './types';

describe('decompileSkillMd', () => {
  it('splits frontmatter and body', () => {
    const { frontmatter, body } = decompileSkillMd(
      '---\nname: foo\ndescription: a skill\n---\n\n# Foo\n\nBody.\n',
    );
    expect(frontmatter).toEqual({ name: 'foo', description: 'a skill' });
    expect(body).toBe('# Foo\n\nBody.\n');
  });

  it('round-trips a compiled SKILL.md (compile → decompile)', () => {
    const spec: Skillspec = {
      name: 'demo',
      sourceDir: '/tmp/demo',
      spec: { name: 'demo', description: 'demo skill', metadata: { opencode: { tags: ['x'] } } },
      body: '# Demo\n\nHello.\n',
      targets: {},
      assets: {},
    };
    const skillMd = compileSkillspec(spec, 'opencode').files['SKILL.md'].toString('utf8');
    const { frontmatter, body } = decompileSkillMd(skillMd);
    expect(frontmatter).toEqual(spec.spec);
    expect(body).toBe('# Demo\n\nHello.\n');
  });

  it('tolerates CRLF frontmatter fences', () => {
    const { frontmatter, body } = decompileSkillMd('---\r\nname: foo\r\n---\r\n\r\nBody.\n');
    expect(frontmatter).toEqual({ name: 'foo' });
    expect(body).toBe('Body.\n');
  });

  it('throws when the frontmatter block is missing', () => {
    expect(() => decompileSkillMd('# No frontmatter\n')).toThrow(SkillspecError);
  });

  it('throws when frontmatter is a sequence, not a mapping', () => {
    expect(() => decompileSkillMd('---\n- a\n- b\n---\n\nBody.\n')).toThrow(SkillspecError);
  });
});
