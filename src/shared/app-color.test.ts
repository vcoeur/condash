import { describe, expect, it } from 'vitest';
import {
  APP_COLOR_SLOT_COUNT,
  appColorClass,
  appColorSlot,
  appHandle,
  appPillText,
} from './app-color';

describe('appHandle', () => {
  it('strips a leading # and lowercases', () => {
    expect(appHandle('#Condash')).toBe('condash');
    expect(appHandle('##condash')).toBe('condash');
    expect(appHandle('CONDASH')).toBe('condash');
  });

  it('leaves a leading @ (the retired sigil) intact so it fails to resolve', () => {
    expect(appHandle('@condash')).toBe('@condash');
  });

  it('keeps dots (no domain stripping; explicit handles own that)', () => {
    expect(appHandle('notes.vcoeur.com')).toBe('notes.vcoeur.com');
  });

  it('takes the basename of a path reference', () => {
    expect(appHandle('~/src/sophie/RechercheAutoAO')).toBe('rechercheautoao');
    expect(appHandle('/abs/path/to/foo')).toBe('foo');
    expect(appHandle('vcoeur.com/blog')).toBe('blog');
    expect(appHandle('/trailing/slash/')).toBe('slash');
  });

  it('normalises Windows backslash separators to /', () => {
    expect(appHandle('vcoeur\\notes.vcoeur.com')).toBe('notes.vcoeur.com');
    expect(appHandle('C:\\Users\\alice\\src\\condash')).toBe('condash');
    expect(appHandle('#vcoeur\\condash')).toBe('condash');
  });

  it('returns empty for empty / #-only input', () => {
    expect(appHandle('')).toBe('');
    expect(appHandle('#')).toBe('');
  });
});

describe('appPillText', () => {
  it('prefixes a single # onto the handle', () => {
    expect(appPillText('condash')).toBe('#condash');
    expect(appPillText('#condash')).toBe('#condash');
    expect(appPillText('Kasten')).toBe('#kasten');
  });
});

describe('appColorSlot', () => {
  it('is deterministic for the same input', () => {
    expect(appColorSlot('condash')).toBe(appColorSlot('condash'));
    expect(appColorSlot('vcoeur.com')).toBe(appColorSlot('vcoeur.com'));
  });

  it('returns a slot inside [0, APP_COLOR_SLOT_COUNT)', () => {
    const samples = [
      'condash',
      'vcoeur.com',
      'notes.vcoeur.com',
      'knoten',
      'quelle',
      'agentsconf',
      'alicepeintures.com',
      '',
      '#',
      'X',
    ];
    for (const s of samples) {
      const slot = appColorSlot(s);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(APP_COLOR_SLOT_COUNT);
    }
  });

  it("normalises leading '#' so `#condash` matches `condash`", () => {
    expect(appColorSlot('#condash')).toBe(appColorSlot('condash'));
    expect(appColorSlot('##condash')).toBe(appColorSlot('condash'));
  });

  it('is case-insensitive', () => {
    expect(appColorSlot('Condash')).toBe(appColorSlot('condash'));
    expect(appColorSlot('CONDASH')).toBe(appColorSlot('condash'));
  });

  it('treats different names as different (palette spreads real app set)', () => {
    // 20-slot palette + djb2 hash should put the 15 known vcoeur apps on
    // at least 10 distinct slots — i.e. at most a handful of collisions.
    // This is the regression bar: dropping the slot count or going back
    // to sum-of-codepoints both squash this below 10.
    const realApps = [
      'condash',
      'vcoeur.com',
      'notes.vcoeur.com',
      'alicepeintures.com',
      'knoten',
      'quelle',
      'agentsconf',
      'agedum',
      'PaintingManager',
      'curriculum',
      'stats.vcoeur.com',
      'vps.vcoeur.com',
      'condash-python',
      '3d-printing-crash-course',
      'conception',
    ];
    const slots = new Set(realApps.map(appColorSlot));
    expect(slots.size).toBeGreaterThanOrEqual(10);
  });
});

describe('appColorClass', () => {
  it('returns `app-pill-<slot>` matching appColorSlot', () => {
    for (const name of ['condash', 'vcoeur.com', 'knoten', '']) {
      expect(appColorClass(name)).toBe(`app-pill-${appColorSlot(name)}`);
    }
  });
});
