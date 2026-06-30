import { describe, expect, it } from 'vitest';
import {
  buildCompletionBody,
  buildSubtitleUserPrompt,
  buildTabUserPrompt,
  parseSubtitle,
  parseTabSummary,
  withTimeout,
} from './summarizer';

describe('parseTabSummary', () => {
  it('parses a clean JSON object and defaults a missing state + activity to idle', () => {
    const reply = JSON.stringify({
      title: 'running tests',
      contextLines: ['vitest watch in condash', 'all green so far'],
      currentAction: 'waiting for file changes',
    });
    expect(parseTabSummary(reply)).toEqual({
      title: 'running tests',
      contextLines: ['vitest watch in condash', 'all green so far'],
      currentAction: 'waiting for file changes',
      state: 'idle',
      activity: 'idle',
    });
  });

  it('keeps a valid state and the awaiting question', () => {
    const reply = JSON.stringify({
      title: 'auth refactor',
      contextLines: [],
      currentAction: 'asking to overwrite',
      state: 'awaiting',
      activity: 'awaiting',
      awaitingPrompt: 'Overwrite state.json? (y/n)',
    });
    const parsed = parseTabSummary(reply);
    expect(parsed?.state).toBe('awaiting');
    expect(parsed?.awaitingPrompt).toBe('Overwrite state.json? (y/n)');
  });

  it('keeps a valid activity and defaults an unrecognised one to idle', () => {
    const ok = parseTabSummary(
      JSON.stringify({ title: 't', contextLines: [], currentAction: 'x', activity: 'making-pr' }),
    );
    expect(ok?.activity).toBe('making-pr');
    const bad = parseTabSummary(
      JSON.stringify({ title: 't', contextLines: [], currentAction: 'x', activity: 'vibing' }),
    );
    expect(bad?.activity).toBe('idle');
  });

  it('defaults an unrecognised state to idle and drops a non-awaiting awaitingPrompt', () => {
    const reply = JSON.stringify({
      title: 'building',
      contextLines: [],
      currentAction: 'compiling',
      state: 'on-fire',
      awaitingPrompt: 'this should be ignored',
    });
    const parsed = parseTabSummary(reply);
    expect(parsed?.state).toBe('idle');
    expect(parsed?.awaitingPrompt).toBeUndefined();
  });

  it('recovers JSON wrapped in prose / a markdown fence', () => {
    const reply =
      'Sure!\n```json\n{"title":"build","contextLines":[],"currentAction":"compiling","state":"working","activity":"implementing"}\n```';
    expect(parseTabSummary(reply)?.title).toBe('build');
    expect(parseTabSummary(reply)?.state).toBe('working');
    expect(parseTabSummary(reply)?.activity).toBe('implementing');
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

describe('parseSubtitle', () => {
  it('extracts the subtitle sentence from a JSON reply', () => {
    expect(parseSubtitle('{"subtitle": "Shipping the dashboard redesign for condash"}')).toBe(
      'Shipping the dashboard redesign for condash',
    );
  });

  it('recovers a subtitle wrapped in a markdown fence', () => {
    expect(parseSubtitle('```json\n{"subtitle":"Refactoring auth"}\n```')).toBe('Refactoring auth');
  });

  it('clamps an overlong subtitle to 140 chars', () => {
    const long = 'x'.repeat(300);
    expect(parseSubtitle(JSON.stringify({ subtitle: long })).length).toBe(140);
  });

  it('returns empty string for a missing or non-string subtitle', () => {
    expect(parseSubtitle('{"subtitle": 5}')).toBe('');
    expect(parseSubtitle('garbage')).toBe('');
    expect(parseSubtitle('{}')).toBe('');
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
        subtitle: '',
        contextLines: ['key sk-AbCdEf0123456789ZyXwVuTs leaked earlier'],
        currentAction: 'waiting',
        state: 'idle',
        activity: 'idle',
        updatedAt: 0,
        events: [],
      },
    });
    expect(prompt).not.toContain('sk-AbCdEf0123456789ZyXwVuTs');
    expect(prompt).toContain('«redacted:api-key»');
  });
});

describe('buildSubtitleUserPrompt redacts secrets in the card facts + provenance', () => {
  it('masks a secret in a context line or a project title', () => {
    const prompt = buildSubtitleUserPrompt(
      {
        title: 'using sk-AbCdEf0123456789ZyXwVuTs',
        currentAction: 'idle',
        contextLines: ['ran with sk-AbCdEf0123456789ZyXwVuTs'],
        activity: 'idle',
        state: 'idle',
      },
      {
        app: 'condash',
        worktree: 'dashboard-redesign',
        projects: [{ slug: 's', title: 'Redesign' }],
      },
    );
    expect(prompt).not.toContain('sk-AbCdEf0123456789ZyXwVuTs');
    expect(prompt).toContain('«redacted:api-key»');
    // Provenance names pass through (no secret shapes).
    expect(prompt).toContain('App: condash');
    expect(prompt).toContain('Worktree/branch: dashboard-redesign');
    expect(prompt).toContain('Project(s): Redesign');
  });
});

describe('buildCompletionBody', () => {
  const base = { model: 'deepseek-v4-flash', system: 'sys', user: 'usr', maxTokens: 1500 };

  it('builds a system+user chat body at temperature 0 with no reasoning switch when reasoning is on', () => {
    const body = buildCompletionBody({ ...base, disableReasoning: false });
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      temperature: 0,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
    });
    expect(body.thinking).toBeUndefined();
  });

  it('adds the DeepSeek thinking:{type:disabled} switch when reasoning is disabled', () => {
    const body = buildCompletionBody({ ...base, disableReasoning: true });
    expect(body.thinking).toEqual({ type: 'disabled' });
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
