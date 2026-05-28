import { describe, expect, it } from 'vitest';
import { APP_COLOR_SLOT_COUNT, appColorClass, appColorSlot } from './app-color';

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
      '@',
      'X',
    ];
    for (const s of samples) {
      const slot = appColorSlot(s);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(APP_COLOR_SLOT_COUNT);
    }
  });

  it("normalises leading '@' so `@condash` matches `condash`", () => {
    expect(appColorSlot('@condash')).toBe(appColorSlot('condash'));
    expect(appColorSlot('@@condash')).toBe(appColorSlot('condash'));
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
