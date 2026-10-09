import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCompletionBody,
  buildTabUserPrompt,
  buildWriterUserPrompt,
  clearWriterCache,
  clearSummarizerError,
  getSummarizerError,
  parseCardWriter,
  parseTabSummary,
  TAB_SYSTEM_PROMPT,
  temperatureForModel,
  withTimeout,
  writeCard,
  summarizeTab,
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
    expect(parsed?.title).toBe('one two three four five six seven');
    expect(parsed?.contextLines).toEqual(['keep']);
  });

  it('returns null without a usable title', () => {
    expect(parseTabSummary('{"contextLines":[]}')).toBeNull();
    expect(parseTabSummary('not json at all')).toBeNull();
    expect(parseTabSummary('{"title": 5}')).toBeNull();
  });
});

describe('parseCardWriter', () => {
  it('extracts the title and subtitle from a JSON reply', () => {
    expect(
      parseCardWriter(
        '{"title": "Dashboard card redesign", "subtitle": "Shipping the dashboard redesign for condash"}',
      ),
    ).toEqual({
      title: 'Dashboard card redesign',
      subtitle: 'Shipping the dashboard redesign for condash',
    });
  });

  it('recovers a reply wrapped in a markdown fence', () => {
    expect(
      parseCardWriter('```json\n{"title":"Refactor auth","subtitle":"Refactoring auth"}\n```'),
    ).toEqual({
      title: 'Refactor auth',
      subtitle: 'Refactoring auth',
    });
  });

  it('clamps an overlong title to 7 words and the subtitle to 140 chars', () => {
    const res = parseCardWriter(
      JSON.stringify({
        title: 'one two three four five six seven eight nine',
        subtitle: 'x'.repeat(300),
      }),
    );
    expect(res.title).toBe('one two three four five six seven');
    expect(res.subtitle.length).toBe(140);
  });

  it('returns empty strings for missing or non-string fields', () => {
    expect(parseCardWriter('{"title": 5, "subtitle": 5}')).toEqual({ title: '', subtitle: '' });
    expect(parseCardWriter('garbage')).toEqual({ title: '', subtitle: '' });
    expect(parseCardWriter('{}')).toEqual({ title: '', subtitle: '' });
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

describe('buildWriterUserPrompt redacts secrets in the card facts + provenance', () => {
  it('masks a secret in a context line or a project title', () => {
    const prompt = buildWriterUserPrompt(
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

  it('sends temperature 1 for a kimi model that rejects 0', () => {
    const body = buildCompletionBody({ ...base, model: 'kimi-k2.7-code', disableReasoning: true });
    expect(body.temperature).toBe(1);
  });
});

describe('temperatureForModel', () => {
  it('returns 1 for kimi/Moonshot models, 0 otherwise', () => {
    expect(temperatureForModel('kimi-k2.7-code')).toBe(1);
    expect(temperatureForModel('moonshot-v1-8k')).toBe(1);
    expect(temperatureForModel('deepseek-v4-flash')).toBe(0);
    expect(temperatureForModel('glm-5.2')).toBe(0);
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

describe('writeCard writer cache', () => {
  const baseConfig = {
    enabled: true,
    provider: 'deepseek' as const,
    apiKey: 'k',
    model: 'm',
    writerModel: 'w',
    cardReasoning: false,
    writerReasoning: false,
    cardInputChars: 16000,
    intervalSec: 120,
    gateOnActivity: true,
    skipIdle: true,
    historyLimit: 20,
  };
  const facts = {
    title: 'Draft title',
    currentAction: 'Editing engine.ts',
    contextLines: ['Refactoring in-flight guard'],
    activity: 'implementing' as const,
    state: 'working' as const,
  };
  const provenance = { app: 'condash', worktree: 'batch-1' };

  beforeEach(() => {
    clearWriterCache();
    clearSummarizerError();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mockWriter(reply = '{"title":"T","subtitle":"S"}') {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          json: async () => ({ choices: [{ message: { content: reply } }] }),
        }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('retains exactly 256 entries, promotes hits and evicts the least recently reused key', async () => {
    const fetchMock = mockWriter();
    const input = (key: number) => ({ ...facts, title: `key ${key}` });
    for (let key = 0; key < 256; key++) await writeCard(baseConfig, input(key), provenance);
    expect(fetchMock).toHaveBeenCalledTimes(256);
    await writeCard(baseConfig, input(0), provenance); // promote oldest
    await writeCard(baseConfig, input(256), provenance);
    await writeCard(baseConfig, input(0), provenance);
    expect(fetchMock).toHaveBeenCalledTimes(257);
    await writeCard(baseConfig, input(1), provenance); // evicted
    expect(fetchMock).toHaveBeenCalledTimes(258);
    // A full replay of the newest retained set proves both ceiling and retention.
    for (const key of [0, 256, 1, ...Array.from({ length: 253 }, (_, i) => i + 3)]) {
      await writeCard(baseConfig, input(key), provenance);
    }
    expect(fetchMock).toHaveBeenCalledTimes(258);
    await writeCard(baseConfig, input(2), provenance);
    expect(fetchMock).toHaveBeenCalledTimes(259);
  });

  it.each([
    { keys: 64, passes: 10, attempts: 640, writers: 64, full: 704 },
    { keys: 129, passes: 3, attempts: 387, writers: 129, full: 516 },
    { keys: 256, passes: 3, attempts: 768, writers: 256, full: 1024 },
    { keys: 257, passes: 3, attempts: 771, writers: 771, full: 1542 },
    { keys: 513, passes: 3, attempts: 1539, writers: 1539, full: 3078 },
  ])(
    'pins full actual-source request ledger for $keys keys × $passes',
    async ({ keys, passes, attempts, writers, full }) => {
      let cards = 0;
      let writerCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, options) => {
          const body = JSON.parse(options.body);
          const card = body.model === baseConfig.model;
          if (card) cards++;
          else writerCalls++;
          const title = card ? body.messages[1].content.match(/fixture-key-(\d+)/)[0] : 'written';
          return {
            ok: true,
            json: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify(
                      card ? { ...facts, title } : { title, subtitle: 'fixture' },
                    ),
                  },
                },
              ],
            }),
          };
        }),
      );
      for (let pass = 0; pass < passes; pass++) {
        for (let key = 0; key < keys; key++) {
          const card = await summarizeTab(baseConfig, {
            sid: 's',
            recentText: `fixture-key-${key}`,
          });
          await writeCard(baseConfig, card!, provenance);
        }
      }
      expect({ cards, writerCalls, fullCalls: cards + writerCalls }).toEqual({
        cards: attempts,
        writerCalls: writers,
        fullCalls: full,
      });
    },
  );

  it('pins hot/cold full request ledger: 17000 cards, 1016 writers, 18016 total', async () => {
    let cards = 0;
    let writers = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        const card = body.model === baseConfig.model;
        if (card) cards++;
        else writers++;
        const title = card ? body.messages[1].content.match(/fixture-key-(\d+)/)[0] : 'written';
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    card ? { ...facts, title } : { title, subtitle: 'fixture' },
                  ),
                },
              },
            ],
          }),
        };
      }),
    );
    for (let cycle = 0; cycle < 1000; cycle++) {
      for (const key of [...Array.from({ length: 16 }, (_, i) => i), 16 + cycle]) {
        const card = await summarizeTab(baseConfig, { sid: 's', recentText: `fixture-key-${key}` });
        await writeCard(baseConfig, card!, provenance);
      }
    }
    expect({ cards, writers, full: cards + writers }).toEqual({
      cards: 17000,
      writers: 1016,
      full: 18016,
    });
  }, 15_000);

  it('keeps model/reasoning separation, explicit clear and no TTL', async () => {
    const fetchMock = mockWriter();
    await writeCard(baseConfig, facts, provenance);
    await writeCard({ ...baseConfig, writerReasoning: true }, facts, provenance);
    await writeCard({ ...baseConfig, writerModel: 'other' }, facts, provenance);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await writeCard(baseConfig, facts, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clearWriterCache();
    await writeCard(baseConfig, facts, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('preserves successful-empty caching, thrown-request retries and endpoint omission', async () => {
    const fetchMock = mockWriter('garbled');
    expect(await writeCard(baseConfig, facts, provenance)).toEqual({ title: '', subtitle: '' });
    await writeCard({ ...baseConfig, baseUrl: 'https://inert.invalid' }, facts, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearWriterCache();
    fetchMock.mockRejectedValue(new Error('fixture rejection'));
    await writeCard(baseConfig, facts, provenance);
    await writeCard(baseConfig, facts, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getSummarizerError()).toBe('fixture rejection');
  });

  it('preserves existing delimiter key collisions without silently repairing the key', async () => {
    const fetchMock = mockWriter();
    await writeCard(baseConfig, { ...facts, contextLines: ['x\0y'] }, provenance);
    await writeCard(baseConfig, { ...facts, contextLines: ['x', 'y'] }, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not deduplicate concurrent identical misses', async () => {
    let resolve!: (value: Response) => void;
    const response = new Promise<Response>((yes) => {
      resolve = yes;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);
    const first = writeCard(baseConfig, facts, provenance);
    const second = writeCard(baseConfig, facts, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    } as Response);
    await Promise.all([first, second]);
    await writeCard(baseConfig, facts, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalid owners cannot insert, promote a hit or overwrite legacy error state', async () => {
    const fetchMock = mockWriter();
    let current = true;
    const reportError = vi.fn();
    const owner = { isCurrent: () => current, reportError };
    let resolve!: (value: Response) => void;
    const response = new Promise<Response>((yes) => {
      resolve = yes;
    });
    fetchMock.mockImplementationOnce(() => response);
    const old = writeCard(baseConfig, facts, provenance, owner);
    current = false;
    clearWriterCache();
    resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"title":"old"}' } }] }),
    } as Response);
    expect(await old).toEqual({ title: '', subtitle: '' });
    await writeCard(baseConfig, facts, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clearWriterCache();
    for (let key = 0; key < 256; key++)
      await writeCard(baseConfig, { ...facts, title: `key ${key}` }, provenance);
    await writeCard(baseConfig, { ...facts, title: 'key 0' }, provenance, owner);
    await writeCard(baseConfig, { ...facts, title: 'key 256' }, provenance);
    const before = fetchMock.mock.calls.length;
    await writeCard(baseConfig, { ...facts, title: 'key 0' }, provenance);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1); // invalid hit never promoted
    fetchMock.mockRejectedValue(new Error('old error'));
    current = true;
    const failed = writeCard(baseConfig, { ...facts, title: 'never cached' }, provenance, owner);
    current = false;
    await failed;
    expect(reportError).not.toHaveBeenCalled();
    expect(getSummarizerError()).toBeNull();
  });

  it('reuses the previous result when facts + provenance + model are unchanged', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          text: async () => '',
          json: async () => ({
            choices: [{ message: { content: '{"title":"T","subtitle":"S"}' } }],
          }),
        } as Response;
      }),
    );
    await writeCard(baseConfig, facts, provenance);
    await writeCard(baseConfig, facts, provenance);
    expect(calls).toBe(1);
    expect(await writeCard(baseConfig, facts, provenance)).toEqual({ title: 'T', subtitle: 'S' });
  });

  it('does not cache when the writer model changes', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          text: async () => '',
          json: async () => ({
            choices: [{ message: { content: '{"title":"T","subtitle":"S"}' } }],
          }),
        } as Response;
      }),
    );
    await writeCard(baseConfig, facts, provenance);
    await writeCard({ ...baseConfig, writerModel: 'other' }, facts, provenance);
    expect(calls).toBe(2);
  });
});
describe('TAB_SYSTEM_PROMPT delegated-agent guidance', () => {
  // Regression guard for the delegated-background-agent idle-misread: an
  // [assistant] tail describing still-running delegated work (the "Waiting for N
  // background agents to finish" state) is grid-only chrome, never framed into the
  // transcript, so the classifier only ever sees the assistant's prose. The prompt
  // must therefore carry the semantic itself. Guards both halves so neither is
  // silently dropped.
  it('classifies still-running background/parallel/sub-agents as working', () => {
    expect(TAB_SYSTEM_PROMPT).toContain('Delegated work is also "working"');
    expect(TAB_SYSTEM_PROMPT).toContain('background / parallel / sub-agents or tasks');
    expect(TAB_SYSTEM_PROMPT).toMatch(/still running[\s\S]*classify "working"/);
  });

  it('still treats finished delegated work as idle', () => {
    expect(TAB_SYSTEM_PROMPT).toMatch(/FINISHED or returned their results[\s\S]*that is "idle"/);
  });
});
