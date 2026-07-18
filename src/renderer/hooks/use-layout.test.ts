import { describe, expect, it } from 'vitest';
import type { LayoutState } from '@shared/types';
import { clampSplit, maskTerminal, splitColumns } from './use-layout';

const base: LayoutState = {
  projects: true,
  leftView: 'projects',
  working: 'code',
  terminal: true,
  projectsSplit: 0.32,
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
    expect(out.projectsSplit).toBe(0.32);
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

describe('clampSplit', () => {
  it('passes a normal fraction through', () => {
    expect(clampSplit(0.5)).toBe(0.5);
  });

  it('bounds a hand-edited extreme', () => {
    expect(clampSplit(0)).toBe(0.02);
    expect(clampSplit(1)).toBe(0.98);
    expect(clampSplit(-4)).toBe(0.02);
    expect(clampSplit(99)).toBe(0.98);
  });

  // The fraction bound must stay looser than the px clamp in `splitColumns`,
  // which is what actually decides where the splitter may sit. If the fraction
  // were the tighter of the two, dragging fully left on a wide band would pin
  // the pane at 200px during the drag and then snap it right on mouseup — the
  // user could never park it where they released.
  it('does not bind at the pixel floor on a wide band', () => {
    for (const bandWidth of [1600, 2560, 3440, 5120]) {
      const atPixelFloor = 200 / bandWidth;
      expect(clampSplit(atPixelFloor)).toBe(atPixelFloor);
      const atPixelCap = (bandWidth - 204) / bandWidth;
      expect(clampSplit(atPixelCap)).toBe(atPixelCap);
    }
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampSplit(Number.NaN)).toBe(0.32);
  });
});

describe('splitColumns', () => {
  // The regression this whole change exists for: a stored *pixel* width kept
  // the Projects pane at its absolute size when the window narrowed, pushing
  // the splitter and the entire working surface off the right edge — where
  // they could not be dragged back. A percentage keeps the split proportional.
  it('sizes the Projects column as a percentage, not a fixed width', () => {
    expect(splitColumns(0.5)).toContain('50.0000%');
    expect(splitColumns(0.5)).not.toMatch(/\d+px\s+4px\s+1fr/);
  });

  it('caps the column so the splitter always stays on screen', () => {
    // 200px min pane + 4px splitter — the handle can never sit closer than
    // that to the right edge, so it is always grabbable.
    expect(splitColumns(0.9)).toContain('calc(100% - 204px)');
  });

  it('floors the column so Projects never collapses', () => {
    expect(splitColumns(0.1)).toContain('clamp(200px,');
  });

  it('clamps an out-of-range fraction before rendering', () => {
    expect(splitColumns(5)).toContain('98.0000%');
  });
});
