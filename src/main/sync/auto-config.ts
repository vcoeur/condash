/**
 * Defaults, clamps, and effective-config reading for the auto-sync engine.
 * Mirrors `src/main/dashboard/config.ts`: the on-disk `autoSync` block (all
 * fields optional) is layered on these defaults, then the numbers are clamped.
 */
import type { AutoSyncConfig, AutoSyncSettings } from '../../shared/types';
import { getEffectiveConceptionConfig } from '../effective-config';

/** Built-in defaults. Off by default; a 10-minute cadence with the standard
 *  90-second quiet period, pushing after each sweep. */
export const AUTO_SYNC_DEFAULTS: AutoSyncConfig = {
  enabled: false,
  intervalMinutes: 10,
  quietPeriodSeconds: 90,
  push: true,
};

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 120;
export const MIN_QUIET_SECONDS = 0;
export const MAX_QUIET_SECONDS = 3600;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Resolve the raw `autoSync` block into a fully-defaulted, clamped config.
 *
 * @param raw the on-disk block, or undefined when unset
 * @returns defaults applied, `intervalMinutes` clamped to [1, 120],
 *          `quietPeriodSeconds` to [0, 3600]
 */
export function resolveAutoSyncConfig(raw: AutoSyncSettings | undefined): AutoSyncConfig {
  return {
    enabled: raw?.enabled ?? AUTO_SYNC_DEFAULTS.enabled,
    intervalMinutes: clamp(
      raw?.intervalMinutes ?? AUTO_SYNC_DEFAULTS.intervalMinutes,
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES,
      AUTO_SYNC_DEFAULTS.intervalMinutes,
    ),
    quietPeriodSeconds: clamp(
      raw?.quietPeriodSeconds ?? AUTO_SYNC_DEFAULTS.quietPeriodSeconds,
      MIN_QUIET_SECONDS,
      MAX_QUIET_SECONDS,
      AUTO_SYNC_DEFAULTS.quietPeriodSeconds,
    ),
    push: raw?.push ?? AUTO_SYNC_DEFAULTS.push,
  };
}

/** Read and resolve the effective `autoSync` config for a conception. */
export async function readAutoSyncConfig(conceptionPath: string): Promise<AutoSyncConfig> {
  const config = await getEffectiveConceptionConfig(conceptionPath);
  return resolveAutoSyncConfig(config.autoSync);
}
