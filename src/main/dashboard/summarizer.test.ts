import { describe, expect, it } from 'vitest';
import {
  buildOverviewUserPrompt,
  buildTabUserPrompt,
  parseOverview,
  parseTabSummary,
  withTimeout,
} from './summarizer';

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

describe('buildTabUserPrompt redacts secrets before they reach the prompt', () => {
  it('masks a secret planted in the recent output', () => {
    const prompt = buildTabUserPrompt({
      sid: 's1',
      cmd: 'bash',
      cwd: '/home/dev/app',
      recentText: 'export GITHUB_TOKEN=ghp_0123456789abcdefABCDEF0123456789abcd\nok',
    });
    expect(prompt).not.toContain('ghp_0123456789abcdefABCDEF0123456789abcd');
    expect(prompt).toContain('«redacted:');
  });

  it('masks a bare token in the command with its kind label', () => {
    const prompt = buildTabUserPrompt({
      sid: 's1',
      cmd: 'deploy ghp_0123456789abcdefABCDEF0123456789abcd',
      recentText: 'idle',
    });
    expect(prompt).not.toContain('ghp_0123456789abcdefABCDEF0123456789abcd');
    expect(prompt).toContain('«redacted:github-token»');
  });

  it('masks a secret carried over in the prior summary', () => {
    const prompt = buildTabUserPrompt({
      sid: 's1',
      cmd: 'deploy',
      recentText: 'idle',
      prior: {
        sid: 's1',
        title: 'deploy',
        contextLines: ['key sk-AbCdEf0123456789ZyXwVuTs leaked earlier'],
        currentAction: 'waiting',
        updatedAt: 0,
        events: [],
      },
    });
    expect(prompt).not.toContain('sk-AbCdEf0123456789ZyXwVuTs');
    expect(prompt).toContain('«redacted:api-key»');
  });
});

describe('buildOverviewUserPrompt redacts secrets in tab summaries', () => {
  it('masks a secret in a tab title or current action', () => {
    const prompt = buildOverviewUserPrompt([
      {
        sid: 's1',
        title: 'using sk-AbCdEf0123456789ZyXwVuTs',
        contextLines: [],
        currentAction: 'idle',
        updatedAt: 0,
        events: [],
      },
    ]);
    expect(prompt).not.toContain('sk-AbCdEf0123456789ZyXwVuTs');
    expect(prompt).toContain('«redacted:api-key»');
  });
});

describe('withTimeout', () => {
  it('passes through a value that resolves before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok');
  });

  it('rejects with a labelled message when the deadline elapses first', async () => {
    // A promise that never settles — only the timeout can win.
    const pending = new Promise<string>(() => {});
    await expect(withTimeout(pending, 5, 'dashboard: completion')).rejects.toThrow(
      /dashboard: completion timed out/,
    );
  });

  it('does not leave a late rejection unhandled when the timeout wins', async () => {
    let rejectLater: (reason: Error) => void = () => {};
    const losing = new Promise<string>((_resolve, reject) => {
      rejectLater = reject;
    });
    await expect(withTimeout(losing, 5, 'test')).rejects.toThrow(/timed out/);
    // Reject the racing promise after it already lost — the no-op catch inside
    // withTimeout must keep this from becoming an unhandled rejection.
    rejectLater(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
