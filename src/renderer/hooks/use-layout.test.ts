import { describe, expect, it } from 'vitest';
import type { LayoutState } from '@shared/types';
import { maskTerminal } from './use-layout';

const base: LayoutState = {
  projects: true,
  leftView: 'projects',
  working: 'code',
  terminal: true,
  projectsWidth: 320,
};

describe('maskTerminal', () => {
  it('masks the terminal closed for display while auto-collapsed', () => {
    expect(maskTerminal(base, true).terminal).toBe(false);
  });

  it('passes the layout through by reference when not collapsed', () => {
    expect(maskTerminal(base, false)).toBe(base);
  });

  it('preserves every non-terminal field while masking', () => {
    const out = maskTerminal(base, true);
    expect(out.projects).toBe(true);
    expect(out.leftView).toBe('projects');
    expect(out.working).toBe('code');
    expect(out.projectsWidth).toBe(320);
  });

  it('never mutates the input, so the persisted preference is preserved', () => {
    // This is the crux of the no-persistence-leak property: the display mask
    // must not alter the base the persistence layer reads back.
    maskTerminal(base, true);
    expect(base.terminal).toBe(true);
  });

  it('leaves an already-collapsed preference collapsed under the mask', () => {
    const collapsed: LayoutState = { ...base, terminal: false };
    expect(maskTerminal(collapsed, true).terminal).toBe(false);
    expect(maskTerminal(collapsed, false).terminal).toBe(false);
  });
});
