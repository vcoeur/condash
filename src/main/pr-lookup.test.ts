/**
 * Unit tests for the pure `gh pr list` JSON parser and for the
 * `listOpenPullRequests` single-flight by cwd. The shell-out isn't exercised
 * for real — it needs a live, authenticated `gh` and a real GitHub repo —
 * so, as with git-details' pure parsers, only the parsing / field-mapping
 * and the caller-sharing logic (over a mocked `exec`) are covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exec } from './exec';
import { listOpenPullRequests, parseGhPrList, parseOpenPrList } from './pr-lookup';

vi.mock('./exec', () => ({ exec: vi.fn() }));

describe('parseGhPrList', () => {
  it('maps the first PR of a populated list', () => {
    const out = JSON.stringify([
      {
        number: 412,
        url: 'https://github.com/vcoeur/condash/pull/412',
        title: 'Add Open PR menu item',
        isDraft: false,
      },
    ]);
    expect(parseGhPrList(out)).toEqual({
      number: 412,
      url: 'https://github.com/vcoeur/condash/pull/412',
      title: 'Add Open PR menu item',
      isDraft: false,
    });
  });

  it('carries the draft flag through', () => {
    const out = JSON.stringify([
      { number: 5, url: 'https://example.com/pull/5', title: 'wip', isDraft: true },
    ]);
    expect(parseGhPrList(out)?.isDraft).toBe(true);
  });

  it('returns the first entry when the list has several', () => {
    const out = JSON.stringify([
      { number: 1, url: 'https://example.com/pull/1', title: 'first', isDraft: false },
      { number: 2, url: 'https://example.com/pull/2', title: 'second', isDraft: false },
    ]);
    expect(parseGhPrList(out)?.number).toBe(1);
  });

  it('defaults a missing title to an empty string', () => {
    const out = JSON.stringify([{ number: 7, url: 'https://example.com/pull/7', isDraft: false }]);
    expect(parseGhPrList(out)).toEqual({
      number: 7,
      url: 'https://example.com/pull/7',
      title: '',
      isDraft: false,
    });
  });

  it('treats a missing isDraft as not-draft', () => {
    const out = JSON.stringify([{ number: 8, url: 'https://example.com/pull/8', title: 'x' }]);
    expect(parseGhPrList(out)?.isDraft).toBe(false);
  });

  it('returns null for an empty list (no open PR)', () => {
    expect(parseGhPrList('[]')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseGhPrList('not json')).toBeNull();
    expect(parseGhPrList('')).toBeNull();
  });

  it('returns null when the payload is not an array', () => {
    expect(parseGhPrList('{"number":1}')).toBeNull();
  });

  it('returns null when required fields are missing or wrong-typed', () => {
    // No number.
    expect(parseGhPrList(JSON.stringify([{ url: 'https://example.com/pull/1' }]))).toBeNull();
    // No url.
    expect(parseGhPrList(JSON.stringify([{ number: 1 }]))).toBeNull();
    // Empty url.
    expect(parseGhPrList(JSON.stringify([{ number: 1, url: '' }]))).toBeNull();
    // number as a string.
    expect(parseGhPrList(JSON.stringify([{ number: '1', url: 'https://x/pull/1' }]))).toBeNull();
  });
});

describe('parseOpenPrList', () => {
  it('maps every well-formed row, carrying the head branch', () => {
    const out = JSON.stringify([
      {
        number: 12,
        url: 'https://example.com/pull/12',
        title: 'feat one',
        isDraft: false,
        headRefName: 'feature-one',
      },
      {
        number: 34,
        url: 'https://example.com/pull/34',
        title: 'feat two',
        isDraft: true,
        headRefName: 'feature-two',
      },
    ]);
    expect(parseOpenPrList(out)).toEqual([
      {
        number: 12,
        url: 'https://example.com/pull/12',
        title: 'feat one',
        isDraft: false,
        headRefName: 'feature-one',
      },
      {
        number: 34,
        url: 'https://example.com/pull/34',
        title: 'feat two',
        isDraft: true,
        headRefName: 'feature-two',
      },
    ]);
  });

  it('drops rows missing a usable head branch or a required field', () => {
    const out = JSON.stringify([
      { number: 1, url: 'https://x/pull/1', headRefName: 'ok' },
      { number: 2, url: 'https://x/pull/2' }, // no headRefName
      { number: 3, url: 'https://x/pull/3', headRefName: '' }, // empty headRefName
      { url: 'https://x/pull/4', headRefName: 'no-number' }, // no number
    ]);
    const result = parseOpenPrList(out);
    expect(result.map((pr) => pr.number)).toEqual([1]);
    expect(result[0].headRefName).toBe('ok');
  });

  it('returns an empty array for empty, non-array, or malformed input', () => {
    expect(parseOpenPrList('[]')).toEqual([]);
    expect(parseOpenPrList('{"number":1}')).toEqual([]);
    expect(parseOpenPrList('not json')).toEqual([]);
    expect(parseOpenPrList('')).toEqual([]);
  });
});

describe('listOpenPullRequests — single-flight by cwd', () => {
  const execMock = vi.mocked(exec);
  let now = 1_000_000;

  const prRow = (number: number, headRefName: string) => ({
    number,
    url: `https://example.com/pull/${number}`,
    title: `PR ${number}`,
    isDraft: false,
    headRefName,
  });

  beforeEach(() => {
    execMock.mockReset();
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collapses concurrent calls for one cwd onto a single exec and a shared array', async () => {
    let resolveLookup!: (value: { stdout: string; stderr: string }) => void;
    execMock.mockImplementation(
      () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const first = listOpenPullRequests('/repo/one');
    const second = listOpenPullRequests('/repo/one');
    expect(execMock).toHaveBeenCalledTimes(1);

    resolveLookup({ stdout: JSON.stringify([prRow(1, 'feature-x')]), stderr: '' });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toHaveLength(1);
    expect(r1[0].headRefName).toBe('feature-x');
    expect(r2).toBe(r1); // both callers awaited the same in-flight promise
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('spawns once per distinct cwd', async () => {
    execMock.mockImplementation(async (_file, _args, options) => ({
      stdout: JSON.stringify([prRow(1, `head-of-${options?.cwd}`)]),
      stderr: '',
    }));

    const [a, b] = await Promise.all([
      listOpenPullRequests('/repo/a'),
      listOpenPullRequests('/repo/b'),
    ]);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(a[0].headRefName).toBe('head-of-/repo/a');
    expect(b[0].headRefName).toBe('head-of-/repo/b');
  });

  it('keeps the TTL cache in front of the in-flight map', async () => {
    execMock.mockImplementation(async () => ({
      stdout: JSON.stringify([prRow(2, 'main')]),
      stderr: '',
    }));

    await listOpenPullRequests('/repo/ttl');
    const again = await listOpenPullRequests('/repo/ttl'); // TTL hit — no spawn
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(again).toHaveLength(1);
  });

  it('clears the in-flight entry on settle, so a later call re-fetches', async () => {
    execMock.mockImplementation(async () => ({ stdout: '[]', stderr: '' }));

    await listOpenPullRequests('/repo/settle');
    now += 30_000; // still inside the TTL — served from cache
    await listOpenPullRequests('/repo/settle');
    expect(execMock).toHaveBeenCalledTimes(1);

    now += 120_000; // TTL expired — must spawn again, not await a dead promise
    await listOpenPullRequests('/repo/settle');
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry on failure and caches no rejection', async () => {
    execMock.mockImplementation(async () => {
      throw new Error('gh: not authenticated');
    });

    const [f1, f2, f3] = await Promise.all([
      listOpenPullRequests('/repo/fail'),
      listOpenPullRequests('/repo/fail'),
      listOpenPullRequests('/repo/fail'),
    ]);
    expect(f1).toEqual([]);
    expect(f2).toEqual([]);
    expect(f3).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);

    now += 120_000; // past the TTL — the failure must not be cached either
    const retried = await listOpenPullRequests('/repo/fail');
    expect(retried).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});
