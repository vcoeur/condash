import { getEffectiveConceptionConfig } from '../effective-config';
import type { DashboardConfig, DashboardConfigView, DashboardSettings } from '../../shared/types';

/** Built-in defaults for the dashboard. The on-disk `dashboard` block (all
 *  fields optional) is layered on top of these; `intervalSec` is then clamped. */
export const DASHBOARD_DEFAULTS = {
  enabled: false,
  provider: 'deepseek' as const,
  model: 'deepseek-v4-flash',
  intervalSec: 120,
  gateOnActivity: true,
  historyLimit: 20,
};

/** Cadence bounds — the user asked for a 30s–5min window. */
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 300;

function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DASHBOARD_DEFAULTS.intervalSec;
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.round(seconds)));
}

/**
 * Resolve the raw `dashboard` config block into a fully-defaulted shape, with
 * `intervalSec` clamped to [30, 300]. The API key falls back to the
 * `DEEPSEEK_API_KEY` environment variable when not set in settings, so a
 * headless / CI run can supply it without writing the per-machine file.
 * `baseUrl` likewise falls back to `DEEPSEEK_BASE_URL`; blank means the
 * provider's built-in endpoint.
 *
 * @param raw - The `dashboard` block from the effective config (may be absent).
 * @returns The resolved config the engine and summarizer consume.
 */
export function resolveDashboardConfig(raw: DashboardSettings | undefined): DashboardConfig {
  const apiKey = raw?.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || undefined;
  const baseUrl = raw?.baseUrl?.trim() || process.env.DEEPSEEK_BASE_URL?.trim() || undefined;
  return {
    enabled: raw?.enabled ?? DASHBOARD_DEFAULTS.enabled,
    provider: raw?.provider ?? DASHBOARD_DEFAULTS.provider,
    apiKey,
    baseUrl,
    model: raw?.model?.trim() || DASHBOARD_DEFAULTS.model,
    intervalSec: clampInterval(raw?.intervalSec ?? DASHBOARD_DEFAULTS.intervalSec),
    gateOnActivity: raw?.gateOnActivity ?? DASHBOARD_DEFAULTS.gateOnActivity,
    historyLimit: raw?.historyLimit ?? DASHBOARD_DEFAULTS.historyLimit,
  };
}

/** Read + resolve the dashboard config for a conception. */
export async function readDashboardConfig(conceptionPath: string): Promise<DashboardConfig> {
  const config = await getEffectiveConceptionConfig(conceptionPath);
  return resolveDashboardConfig(config.dashboard);
}

/** Project a resolved config to the renderer-safe view: drop the raw key,
 *  expose only whether one is set. */
export function toDashboardConfigView(config: DashboardConfig): DashboardConfigView {
  return {
    enabled: config.enabled,
    provider: config.provider,
    hasApiKey: Boolean(config.apiKey),
    baseUrl: config.baseUrl,
    model: config.model,
    intervalSec: config.intervalSec,
    gateOnActivity: config.gateOnActivity,
    historyLimit: config.historyLimit,
  };
}
