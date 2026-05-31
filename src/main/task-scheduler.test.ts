import { describe, expect, it } from 'vitest';
import { resolveRunTimeout } from './task-scheduler';

const DEFAULT_MS = 10 * 60_000;

describe('resolveRunTimeout', () => {
  it('uses the per-task timeout when set', () => {
    expect(resolveRunTimeout({ timeout: '1m' })).toBe(60_000);
    expect(resolveRunTimeout({ timeout: '30s' })).toBe(30_000);
    expect(resolveRunTimeout({ timeout: '1h' })).toBe(3_600_000);
  });

  it('falls back to the 10m default when absent or unparseable', () => {
    expect(resolveRunTimeout(undefined)).toBe(DEFAULT_MS);
    expect(resolveRunTimeout({})).toBe(DEFAULT_MS);
    expect(resolveRunTimeout({ timeout: '' })).toBe(DEFAULT_MS);
    expect(resolveRunTimeout({ timeout: 'soon' })).toBe(DEFAULT_MS);
  });
});
