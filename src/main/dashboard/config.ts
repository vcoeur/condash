import { getEffectiveConceptionConfig } from '../effective-config';
import type { DashboardConfig, DashboardConfigView, DashboardSettings } from '../../shared/types';

/** Built-in defaults for the dashboard. The on-disk `dashboard` block (all
 *  fields optional) is layered on top of these; `intervalSec` is then clamped. */
export const DASHBOARD_DEFAULTS = {
  enabled: false,
  provider: 'deepseek' as const,
  // Two model tiers: a cheap, reasoning-off `model` pre-processes each tab's raw
  // window into facts + state/activity + a draft title; a richer `writerModel`
  // composes the published title + one-sentence subtitle from those facts. Both
  // default reasoning-off: a model bake-off over a week of real logs found
  // reasoning-on adds 4-10x latency with no title gain on the card tier and
  // returns an empty reply on a non-trivial fraction of writer calls —
  // unacceptable now that the writer owns the title.
  model: 'deepseek-v4-flash',
  writerModel: 'deepseek-v4-pro',
  cardReasoning: false,
  writerReasoning: false,
  cardInputChars: 16000,
  intervalSec: 120,
  gateOnActivity: true,
  skipIdle: true,
  historyLimit: 20,
};

/** Lower bound on the card input window; a too-small value starves fact
 *  extraction. Mirrors the legacy fixed window as the floor. */
export const MIN_CARD_INPUT_CHARS = 2000;

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
  const model = raw?.model?.trim() || DASHBOARD_DEFAULTS.model;
  return {
    enabled: raw?.enabled ?? DASHBOARD_DEFAULTS.enabled,
    provider: raw?.provider ?? DASHBOARD_DEFAULTS.provider,
    apiKey,
    baseUrl,
    model,
    // A single-tier config (only `model` set) drives the writer with the same
    // model, preserving today's behaviour until a writer tier is configured.
    writerModel: raw?.writerModel?.trim() || raw?.model?.trim() || DASHBOARD_DEFAULTS.writerModel,
    cardReasoning: raw?.cardReasoning ?? DASHBOARD_DEFAULTS.cardReasoning,
    writerReasoning: raw?.writerReasoning ?? DASHBOARD_DEFAULTS.writerReasoning,
    cardInputChars: Math.max(
      MIN_CARD_INPUT_CHARS,
      Math.round(raw?.cardInputChars ?? DASHBOARD_DEFAULTS.cardInputChars),
    ),
    intervalSec: clampInterval(raw?.intervalSec ?? DASHBOARD_DEFAULTS.intervalSec),
    gateOnActivity: raw?.gateOnActivity ?? DASHBOARD_DEFAULTS.gateOnActivity,
    skipIdle: raw?.skipIdle ?? DASHBOARD_DEFAULTS.skipIdle,
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
    writerModel: config.writerModel,
    cardReasoning: config.cardReasoning,
    writerReasoning: config.writerReasoning,
    cardInputChars: config.cardInputChars,
    intervalSec: config.intervalSec,
    gateOnActivity: config.gateOnActivity,
    skipIdle: config.skipIdle,
    historyLimit: config.historyLimit,
  };
}
