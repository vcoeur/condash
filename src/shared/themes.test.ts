import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PAIR,
  THEME_PRESETS,
  THEME_VALUES,
  nextTheme,
  resolveThemePreset,
  themeLabel,
} from './themes';
import type { Theme } from './themes';

describe('theme registry', () => {
  it('exposes every preset id plus system, with no duplicates', () => {
    expect(THEME_VALUES).toEqual(['system', 'light', 'mist', 'dark', 'nocturne', 'console']);
    expect(new Set(THEME_VALUES).size).toBe(THEME_VALUES.length);
  });

  it('names only real presets in the system pair, one of each kind', () => {
    const byId = new Map(THEME_PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.get(SYSTEM_PAIR.light)?.kind).toBe('light');
    expect(byId.get(SYSTEM_PAIR.dark)?.kind).toBe('dark');
  });

  it('gives every preset a three-colour hex swatch', () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.swatch).toHaveLength(3);
      for (const hue of preset.swatch) expect(hue).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('resolveThemePreset', () => {
  it('resolves an explicit id regardless of the OS preference', () => {
    for (const systemPrefersDark of [true, false]) {
      expect(resolveThemePreset('console', systemPrefersDark).id).toBe('console');
      expect(resolveThemePreset('light', systemPrefersDark).id).toBe('light');
    }
  });

  it('follows the OS preference for system', () => {
    expect(resolveThemePreset('system', true).id).toBe(SYSTEM_PAIR.dark);
    expect(resolveThemePreset('system', false).id).toBe(SYSTEM_PAIR.light);
  });

  // A settings.json written by a newer build (or hand-edited) must not leave
  // the app unstyled — it degrades to the OS-following pair.
  it('falls back to the OS pair for an unknown id', () => {
    const unknown = 'broadsheet' as Theme;
    expect(resolveThemePreset(unknown, true).id).toBe(SYSTEM_PAIR.dark);
    expect(resolveThemePreset(unknown, false).id).toBe(SYSTEM_PAIR.light);
  });

  it('reports console as dark — the case a `theme === dark` check would miss', () => {
    expect(resolveThemePreset('console', false).kind).toBe('dark');
  });
});

describe('nextTheme', () => {
  it('cycles through every value and returns to the start', () => {
    const seen: Theme[] = [];
    let current: Theme = 'system';
    for (let step = 0; step < THEME_VALUES.length; step += 1) {
      seen.push(current);
      current = nextTheme(current);
    }
    expect(seen).toEqual(THEME_VALUES);
    expect(current).toBe('system');
  });

  it('restarts the cycle from an unknown value', () => {
    expect(nextTheme('broadsheet' as Theme)).toBe('system');
  });
});

describe('themeLabel', () => {
  it('labels system and each preset', () => {
    expect(themeLabel('system')).toBe('System');
    expect(themeLabel('light')).toBe('Paper');
    expect(themeLabel('mist')).toBe('Mist');
    expect(themeLabel('dark')).toBe('Warm Gallery');
    expect(themeLabel('nocturne')).toBe('Nocturne');
    expect(themeLabel('console')).toBe('Console');
  });
});
