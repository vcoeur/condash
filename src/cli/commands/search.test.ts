/**
 * Tests for `condash search` — the cross-tree search CLI verb.
 *
 * Also covers two audit-tail items:
 *   - P1-5  concurrency cap on file reads (regression test below).
 *   - P2-12 scoring rationale comment landed in match.ts + scorer.ts (no
 *           behavioural change to assert — covered by passing scoring tests).
 */
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSearch } from './search';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  writeKnowledgeFile,
  writeProjectReadme,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

async function seedTwoSources(): Promise<void> {
  await writeProjectReadme(conceptionPath, 'unicorn-feature', {
    date: '2026-05-01',
    kind: 'project',
    status: 'now',
    apps: ['condash'],
    title: 'Unicorn feature project',
    body: '## Goal\n\nThis project ships the unicorn feature.\n',
  });
  await writeKnowledgeFile(
    conceptionPath,
    'topics/unicorn.md',
    '# Unicorn topic\n\nReference notes about unicorn.\n',
  );
  await writeKnowledgeFile(
    conceptionPath,
    'topics/unrelated.md',
    '# Unrelated\n\nNothing here matches.\n',
  );
}

describe('runSearch', () => {
  it('returns hits across projects and knowledge', async () => {
    await seedTwoSources();
    const { stdout, threw } = await captureStdout(() =>
      runSearch(
        { noun: 'search', verb: '', positional: ['unicorn'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      hits: Array<{ relPath: string; source: string }>;
      query: string;
    }>(stdout).data!;
    expect(data.query).toBe('unicorn');
    const sources = new Set(data.hits.map((h) => h.source));
    expect(sources.has('project')).toBe(true);
    expect(sources.has('knowledge')).toBe(true);
  });

  it('emits empty hits when the query matches nothing', async () => {
    await seedTwoSources();
    const { stdout } = await captureStdout(() =>
      runSearch(
        { noun: 'search', verb: '', positional: ['no-such-token'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ hits: unknown[] }>(stdout).data!;
    expect(data.hits).toEqual([]);
  });

  it('--scope projects filters out knowledge hits', async () => {
    await seedTwoSources();
    const { stdout } = await captureStdout(() =>
      runSearch(
        { noun: 'search', verb: '', positional: ['unicorn'], flags: { scope: 'projects' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ hits: Array<{ source: string }> }>(stdout).data!;
    expect(data.hits.length).toBeGreaterThan(0);
    for (const hit of data.hits) expect(hit.source).toBe('project');
  });

  it('--scope knowledge filters out project hits', async () => {
    await seedTwoSources();
    const { stdout } = await captureStdout(() =>
      runSearch(
        { noun: 'search', verb: '', positional: ['unicorn'], flags: { scope: 'knowledge' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ hits: Array<{ source: string }> }>(stdout).data!;
    expect(data.hits.length).toBeGreaterThan(0);
    for (const hit of data.hits) expect(hit.source).toBe('knowledge');
  });

  it('--scope invalid throws USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runSearch(
        { noun: 'search', verb: '', positional: ['x'], flags: { scope: 'banana' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('--limit caps the returned hits', async () => {
    // Seed many project READMEs all matching the query so we have a clear
    // cap to assert on.
    for (let i = 0; i < 10; i++) {
      await writeProjectReadme(conceptionPath, `seedling-${i}`, {
        date: '2026-05-01',
        kind: 'project',
        status: 'now',
        title: `Seedling ${i}`,
        body: '## Goal\n\nMatches the cabbage query.\n',
      });
    }
    const { stdout } = await captureStdout(() =>
      runSearch(
        { noun: 'search', verb: '', positional: ['cabbage'], flags: { limit: '3' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ hits: unknown[] }>(stdout).data!;
    expect(data.hits.length).toBeLessThanOrEqual(3);
  });

  it('USAGE error when query is empty', async () => {
    const { threw } = await captureStdout(() =>
      runSearch({ noun: 'search', verb: '', positional: [], flags: {} }, jsonCtx(), conceptionPath),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('--help prints usage and returns OK', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runSearch(
        { noun: 'search', verb: '', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
        true, // universalHelp
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash search/);
  });
});

describe('runSearch — P1-5 concurrency cap', () => {
  it('does not open more than the cap concurrent fs.readFile calls', async () => {
    // Seed ~100 markdown files under knowledge/ so the matcher has plenty of
    // candidates to read. Without the cap the test would also pass — what
    // we're guarding against is a *future* regression that removes the cap;
    // we measure the live ceiling by counting concurrent opens.
    for (let i = 0; i < 100; i++) {
      await writeKnowledgeFile(
        conceptionPath,
        `topics/file-${i.toString().padStart(3, '0')}.md`,
        `# File ${i}\n\nContent with the token banana on every page.\n`,
      );
    }

    let active = 0;
    let peak = 0;
    const origReadFile = fs.readFile;
    const fsAny = fs as unknown as { readFile: typeof origReadFile };
    fsAny.readFile = (async (path: unknown, ...rest: unknown[]) => {
      active++;
      if (active > peak) peak = active;
      try {
        return await origReadFile(path as Parameters<typeof origReadFile>[0], ...(rest as never[]));
      } finally {
        active--;
      }
    }) as typeof origReadFile;

    try {
      await captureStdout(() =>
        runSearch(
          { noun: 'search', verb: '', positional: ['banana'], flags: {} },
          jsonCtx(),
          conceptionPath,
        ),
      );
    } finally {
      fsAny.readFile = origReadFile;
    }
    // The internal cap is 32; allow generous headroom in case other code
    // paths read settings/configs concurrently. The point is to detect a
    // future "remove the cap" regression — without the cap, peak hits the
    // file count (100+).
    expect(peak).toBeLessThanOrEqual(64);
  });
});
