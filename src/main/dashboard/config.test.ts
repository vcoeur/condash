import { describe, expect, it } from 'vitest';
import { DASHBOARD_DEFAULTS, MIN_CARD_INPUT_CHARS, resolveDashboardConfig } from './config';

describe('resolveDashboardConfig — two model tiers', () => {
  it('applies the two-tier defaults when nothing is set', () => {
    const config = resolveDashboardConfig(undefined);
    expect(config.model).toBe(DASHBOARD_DEFAULTS.model);
    expect(config.writerModel).toBe(DASHBOARD_DEFAULTS.writerModel);
    expect(config.cardReasoning).toBe(false);
    expect(config.writerReasoning).toBe(true);
    expect(config.cardInputChars).toBe(DASHBOARD_DEFAULTS.cardInputChars);
  });

  it('drives the writer with the card model when only legacy `model` is set (back-compat)', () => {
    const config = resolveDashboardConfig({ model: 'custom-model' });
    expect(config.model).toBe('custom-model');
    // No writerModel set → reuse the single configured model, not the pro default,
    // so a single-model endpoint keeps working unchanged.
    expect(config.writerModel).toBe('custom-model');
  });

  it('honours an explicit writerModel over the card model', () => {
    const config = resolveDashboardConfig({ model: 'flash-x', writerModel: 'pro-x' });
    expect(config.model).toBe('flash-x');
    expect(config.writerModel).toBe('pro-x');
  });

  it('respects explicit reasoning flags', () => {
    const config = resolveDashboardConfig({ cardReasoning: true, writerReasoning: false });
    expect(config.cardReasoning).toBe(true);
    expect(config.writerReasoning).toBe(false);
  });

  it('clamps a too-small card window up to the floor', () => {
    expect(resolveDashboardConfig({ cardInputChars: 100 }).cardInputChars).toBe(
      MIN_CARD_INPUT_CHARS,
    );
  });
});
