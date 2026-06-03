import { describe, expect, it } from 'vitest';
import type { Agent } from '../../../shared/types';
import { blankDraft, formatCadence, formatElapsed, tailText, DEFAULT_TIMEOUT } from './data';

function agent(id: string, promptFlags?: boolean): Agent {
  return { id, label: id, command: id, ...(promptFlags === undefined ? {} : { promptFlags }) };
}

describe('formatCadence', () => {
  it('renders a single unit', () => {
    expect(formatCadence(300_000)).toBe('5m');
    expect(formatCadence(7 * 86_400_000)).toBe('7d');
    expect(formatCadence(3_600_000)).toBe('1h');
    expect(formatCadence(30_000)).toBe('30s');
  });

  it('folds an odd input into the largest-first composite', () => {
    expect(formatCadence(5_400_000)).toBe('1h 30m'); // 90m
    expect(formatCadence(90_000)).toBe('1m 30s');
    expect(formatCadence(90_061_000)).toBe('1d 1h 1m 1s');
  });

  it('drops zero-valued units rather than padding them', () => {
    expect(formatCadence(86_400_000 + 60_000)).toBe('1d 1m'); // no 0h, no 0s
  });

  it('returns empty string for sub-second input', () => {
    expect(formatCadence(0)).toBe('');
    expect(formatCadence(999)).toBe('');
  });
});

describe('formatElapsed', () => {
  it('shows minutes and zero-padded seconds under an hour', () => {
    expect(formatElapsed(0)).toBe('0m 00s');
    expect(formatElapsed(63_000)).toBe('1m 03s');
    expect(formatElapsed(123_456)).toBe('2m 03s');
  });

  it('shows hours and zero-padded minutes at or above an hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(3_840_000)).toBe('1h 04m');
  });

  it('clamps a negative elapsed (clock skew) to zero', () => {
    expect(formatElapsed(-5000)).toBe('0m 00s');
  });
});

describe('tailText', () => {
  it('returns the text unchanged when within the cap', () => {
    expect(tailText('short', 4000)).toBe('short');
    expect(tailText('exact', 5)).toBe('exact');
  });

  it('keeps the last `max` chars and prefixes an ellipsis when truncated', () => {
    expect(tailText('abcdef', 3)).toBe('…def');
  });

  it('defaults to a 4000-char cap', () => {
    const long = 'x'.repeat(4100);
    const out = tailText(long);
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBe(4001); // ellipsis + last 4000
  });
});

describe('blankDraft', () => {
  it('prefers the first prompt-seedable agent', () => {
    const draft = blankDraft([agent('opaque'), agent('seedable', true), agent('also', true)]);
    expect(draft.agent).toBe('seedable');
  });

  it('falls back to the first agent when none is prompt-seedable', () => {
    expect(blankDraft([agent('a'), agent('b')]).agent).toBe('a');
  });

  it('leaves the agent empty when there are no agents', () => {
    expect(blankDraft([]).agent).toBe('');
  });

  it('seeds a create-mode draft with the documented defaults', () => {
    const draft = blankDraft([]);
    expect(draft.editingSlug).toBeNull();
    expect(draft.slugDirty).toBe(false);
    expect(draft.schedule).toBe('');
    expect(draft.timeout).toBe(DEFAULT_TIMEOUT);
    expect(draft.runMode).toBe('interactive');
    expect(draft.excludeFromLogs).toBe(false);
    expect(draft.gateOnUpdatedTabs).toBe(false);
  });
});
