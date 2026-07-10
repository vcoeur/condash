import { describe, expect, it } from 'vitest';
import {
  AUTO_SYNC_DEFAULTS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  resolveAutoSyncConfig,
} from './auto-config';

describe('resolveAutoSyncConfig', () => {
  it('applies the defaults when nothing is set', () => {
    expect(resolveAutoSyncConfig(undefined)).toEqual(AUTO_SYNC_DEFAULTS);
  });

  it('honours explicit values', () => {
    expect(resolveAutoSyncConfig({ enabled: true, intervalMinutes: 5, push: false })).toEqual({
      enabled: true,
      intervalMinutes: 5,
      quietPeriodSeconds: AUTO_SYNC_DEFAULTS.quietPeriodSeconds,
      push: false,
    });
  });

  it('clamps the interval to [1, 120]', () => {
    expect(resolveAutoSyncConfig({ intervalMinutes: 0 }).intervalMinutes).toBe(
      MIN_INTERVAL_MINUTES,
    );
    expect(resolveAutoSyncConfig({ intervalMinutes: 9999 }).intervalMinutes).toBe(
      MAX_INTERVAL_MINUTES,
    );
  });

  it('clamps the quiet period to [0, 3600] and allows 0', () => {
    expect(resolveAutoSyncConfig({ quietPeriodSeconds: 0 }).quietPeriodSeconds).toBe(0);
    expect(resolveAutoSyncConfig({ quietPeriodSeconds: -5 }).quietPeriodSeconds).toBe(0);
    expect(resolveAutoSyncConfig({ quietPeriodSeconds: 99999 }).quietPeriodSeconds).toBe(3600);
  });

  it('falls back to the default interval on a non-finite value', () => {
    expect(resolveAutoSyncConfig({ intervalMinutes: NaN }).intervalMinutes).toBe(
      AUTO_SYNC_DEFAULTS.intervalMinutes,
    );
  });
});
