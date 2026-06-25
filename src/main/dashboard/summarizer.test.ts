import { describe, expect, it } from 'vitest';
import { parseOverview, parseTabSummary } from './summarizer';

describe('parseTabSummary', () => {
  it('parses a clean JSON object', () => {
    const reply = JSON.stringify({
      title: 'running tests',
      contextLines: ['vitest watch in condash', 'all green so far'],
      currentAction: 'waiting for file changes',
    });
    expect(parseTabSummary(reply)).toEqual({
      title: 'running tests',
      contextLines: ['vitest watch in condash', 'all green so far'],
      currentAction: 'waiting for file changes',
    });
  });

  it('recovers JSON wrapped in prose / a markdown fence', () => {
    const reply =
      'Sure!\n```json\n{"title":"build","contextLines":[],"currentAction":"compiling"}\n```';
    expect(parseTabSummary(reply)?.title).toBe('build');
  });

  it('clamps an overlong title to a few words and drops blank context lines', () => {
    const reply = JSON.stringify({
      title: 'one two three four five six seven eight',
      contextLines: ['keep', '', '   '],
      currentAction: 'x',
    });
    const parsed = parseTabSummary(reply);
    expect(parsed?.title).toBe('one two three four five six');
    expect(parsed?.contextLines).toEqual(['keep']);
  });

  it('returns null without a usable title', () => {
    expect(parseTabSummary('{"contextLines":[]}')).toBeNull();
    expect(parseTabSummary('not json at all')).toBeNull();
    expect(parseTabSummary('{"title": 5}')).toBeNull();
  });
});

describe('parseOverview', () => {
  it('parses overview + events', () => {
    const reply = JSON.stringify({
      overview: ['building condash', 'tests passing'],
      events: ['PR opened'],
    });
    expect(parseOverview(reply)).toEqual({
      overview: ['building condash', 'tests passing'],
      events: ['PR opened'],
    });
  });

  it('defaults events to empty and caps overview length', () => {
    const reply = JSON.stringify({ overview: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const parsed = parseOverview(reply);
    expect(parsed?.events).toEqual([]);
    expect(parsed?.overview).toHaveLength(5);
  });

  it('returns null when overview is empty or missing', () => {
    expect(parseOverview('{"overview":[]}')).toBeNull();
    expect(parseOverview('garbage')).toBeNull();
  });
});
