import { describe, expect, it } from 'vitest';
import {
  PROJECT_COLOR_SLOT_COUNT,
  type ProjectColorRef,
  projectColorClass,
  projectColorSlot,
  projectFamilyKey,
} from './project-color';

describe('projectFamilyKey', () => {
  it('uses the slug for a root project (no parent)', () => {
    expect(projectFamilyKey({ slug: '2026-07-15-foo', parent: null })).toBe('2026-07-15-foo');
    expect(projectFamilyKey({ slug: '2026-07-15-foo' })).toBe('2026-07-15-foo');
    expect(projectFamilyKey({ slug: '2026-07-15-foo', parent: '' })).toBe('2026-07-15-foo');
  });

  it('uses the parent slug for a subproject so the family shares a key', () => {
    const parent: ProjectColorRef = { slug: '2026-07-15-plan', parent: null };
    const childA: ProjectColorRef = { slug: '2026-07-15-impl-a', parent: '2026-07-15-plan' };
    const childB: ProjectColorRef = { slug: '2026-07-15-impl-b', parent: '2026-07-15-plan' };
    expect(projectFamilyKey(childA)).toBe(projectFamilyKey(parent));
    expect(projectFamilyKey(childB)).toBe(projectFamilyKey(parent));
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
  it('returns `proj-family-<slot>` matching the family-keyed slot', () => {
    const child: ProjectColorRef = { slug: '2026-07-15-impl', parent: '2026-07-15-plan' };
    expect(projectColorClass(child)).toBe(`proj-family-${projectColorSlot('2026-07-15-plan')}`);
    expect(projectColorClass({ slug: '2026-07-15-plan' })).toBe(
      `proj-family-${projectColorSlot('2026-07-15-plan')}`,
    );
  });

  it('gives a parent and its subproject the same class', () => {
    const parent: ProjectColorRef = { slug: '2026-07-15-plan' };
    const child: ProjectColorRef = { slug: '2026-07-15-impl', parent: '2026-07-15-plan' };
    expect(projectColorClass(child)).toBe(projectColorClass(parent));
  });
});
