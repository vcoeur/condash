import { describe, expect, it } from 'vitest';
import {
  PROJECT_COLOR_SLOT_COUNT,
  familyRootOf,
  projectColorClass,
  projectColorSlot,
} from './project-color';

/** parentOf over a static edge map — an entry is only "resolving" when its
 *  target is itself a known item, mirroring the renderer's list-wide lookup. */
const parentLookup =
  (edges: Record<string, string | undefined>) =>
  (slug: string): string | undefined => {
    const parent = edges[slug];
    return parent !== undefined && parent in edges ? parent : undefined;
  };

describe('familyRootOf', () => {
  it('is the slug itself for a root or a standalone item', () => {
    const parentOf = parentLookup({ '2026-07-15-plan': undefined, '2026-07-15-solo': undefined });
    expect(familyRootOf('2026-07-15-plan', parentOf)).toBe('2026-07-15-plan');
    expect(familyRootOf('2026-07-15-solo', parentOf)).toBe('2026-07-15-solo');
  });

  it('walks a chain to the top so every level shares one root', () => {
    const parentOf = parentLookup({
      '2026-07-15-plan': undefined,
      '2026-07-16-mid': '2026-07-15-plan',
      '2026-07-17-leaf': '2026-07-16-mid',
    });
    expect(familyRootOf('2026-07-16-mid', parentOf)).toBe('2026-07-15-plan');
    expect(familyRootOf('2026-07-17-leaf', parentOf)).toBe('2026-07-15-plan');
  });

  it('stops at the last resolving item under a dangling link', () => {
    // `mid` declares a parent that no longer exists; it heads its own family.
    const parentOf = parentLookup({
      '2026-07-16-mid': '2026-01-01-never-existed',
      '2026-07-17-leaf': '2026-07-16-mid',
    });
    expect(familyRootOf('2026-07-16-mid', parentOf)).toBe('2026-07-16-mid');
    expect(familyRootOf('2026-07-17-leaf', parentOf)).toBe('2026-07-16-mid');
  });

  it('is the item itself for a self-parent', () => {
    const parentOf = parentLookup({ '2026-07-15-loop': '2026-07-15-loop' });
    expect(familyRootOf('2026-07-15-loop', parentOf)).toBe('2026-07-15-loop');
  });

  it('gives every member of a cycle the same root, and a node under the cycle too', () => {
    const parentOf = parentLookup({
      '2026-07-15-a': '2026-07-16-b',
      '2026-07-16-b': '2026-07-15-a',
      '2026-07-17-c': '2026-07-15-a',
    });
    expect(familyRootOf('2026-07-15-a', parentOf)).toBe('2026-07-15-a');
    expect(familyRootOf('2026-07-16-b', parentOf)).toBe('2026-07-15-a');
    expect(familyRootOf('2026-07-17-c', parentOf)).toBe('2026-07-15-a');
  });
});

describe('projectColorSlot', () => {
  it('is deterministic for the same key', () => {
    expect(projectColorSlot('2026-07-15-foo')).toBe(projectColorSlot('2026-07-15-foo'));
  });

  it('returns a slot inside [0, PROJECT_COLOR_SLOT_COUNT)', () => {
    const samples = ['', '2026-07-15-foo', '2026-01-01-a', 'x', 'projects-card-colors'];
    for (const s of samples) {
      const slot = projectColorSlot(s);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(PROJECT_COLOR_SLOT_COUNT);
    }
  });

  it('spreads a realistic set of slugs across several slots', () => {
    const slugs = [
      '2026-07-15-projects-card-colors',
      '2026-07-15-condash-term-tab-autorefresh-regression',
      '2026-07-15-pm-sync-review',
      '2026-05-17-project-card-actions-dropdown',
      '2026-04-17-foo',
      '2026-03-02-alicepeintures-shop-phase-3',
      '2026-02-11-being-able-to-sell',
      '2026-01-09-cart-and-checkout',
    ];
    const slots = new Set(slugs.map(projectColorSlot));
    expect(slots.size).toBeGreaterThanOrEqual(5);
  });
});

describe('projectColorClass', () => {
  it('returns `proj-family-<slot>` for the family root', () => {
    expect(projectColorClass('2026-07-15-plan')).toBe(
      `proj-family-${projectColorSlot('2026-07-15-plan')}`,
    );
  });

  it('gives every card that resolves to one root the same class', () => {
    const parentOf = parentLookup({
      '2026-07-15-plan': undefined,
      '2026-07-16-impl': '2026-07-15-plan',
    });
    expect(projectColorClass(familyRootOf('2026-07-16-impl', parentOf))).toBe(
      projectColorClass(familyRootOf('2026-07-15-plan', parentOf)),
    );
  });
});
