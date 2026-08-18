/**
 * Handler-level tests for `condash knowledge`: tree / verify / retrieve /
 * stamp / index. Each verb gets a focused fixture under tmp knowledge/.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runKnowledge } from './knowledge';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  writeKnowledgeFile,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

describe('knowledge tree', () => {
  it('renders the knowledge/ tree with file + directory children', async () => {
    await writeKnowledgeFile(conceptionPath, 'topics/alpha.md', '# Alpha\n\nBody.\n');
    await writeKnowledgeFile(conceptionPath, 'topics/beta.md', '# Beta');
    await writeKnowledgeFile(conceptionPath, 'internal/condash.md', '# condash\n\nBody.\n');

    const { stdout, threw } = await captureStdout(() =>
      runKnowledge(
        'tree',
        { noun: 'knowledge', verb: 'tree', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const node = parseJsonEnvelope<{
      name: string;
      kind: string;
      children?: Array<{
        name: string;
        kind: string;
        children?: Array<{ name: string; kind: string; lines?: number }>;
      }>;
    }>(stdout).data!;
    expect(node.kind).toBe('directory');
    const dirNames = node.children!.filter((c) => c.kind === 'directory').map((c) => c.name);
    expect(dirNames).toContain('topics');
    expect(dirNames).toContain('internal');
    // File nodes carry `lines` with wc -l semantics: the `\n` count (a
    // trailing newline counts; a one-line file without one reports 0).
    const topics = node.children!.find((c) => c.name === 'topics')!;
    const alpha = topics.children!.find((c) => c.name === 'alpha.md')!;
    expect(alpha.lines).toBe(3);
    const beta = topics.children!.find((c) => c.name === 'beta.md')!;
    expect(beta.lines).toBe(0);
  });

  it('--depth 1 trims grandchildren', async () => {
    await writeKnowledgeFile(conceptionPath, 'topics/alpha.md', '# Alpha\n');
    await writeKnowledgeFile(conceptionPath, 'topics/beta.md', '# Beta\n');
    const { stdout } = await captureStdout(() =>
      runKnowledge(
        'tree',
        { noun: 'knowledge', verb: 'tree', positional: [], flags: { depth: '1' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const node = parseJsonEnvelope<{ children?: Array<{ children?: unknown }> }>(stdout).data!;
    for (const child of node.children!) {
      expect(child.children).toBeUndefined();
    }
  });
});

describe('knowledge verify', () => {
  it('OK when every stamp is fresh', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await writeKnowledgeFile(
      conceptionPath,
      'topics/fresh.md',
      `# Fresh\n\n**Verified:** ${today} condash@abc1234 on main\n\nBody.\n`,
    );
    const { stdout, threw } = await captureStdout(() =>
      runKnowledge(
        'verify',
        { noun: 'knowledge', verb: 'verify', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ stale: unknown[]; fresh: number }>(stdout).data!;
    expect(data.stale).toEqual([]);
    expect(data.fresh).toBe(1);
  });

  it('flags a stamp older than --max-age days', async () => {
    await writeKnowledgeFile(
      conceptionPath,
      'topics/stale.md',
      '# Stale\n\n**Verified:** 2020-01-01 ancient@deadbeef on main\n\nBody.\n',
    );
    const { stdout } = await captureStdout(() =>
      runKnowledge(
        'verify',
        { noun: 'knowledge', verb: 'verify', positional: [], flags: { 'max-age': '90' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{
      stale: Array<{ relPath: string; verifiedAt: string }>;
      issues: Array<{ check: string; severity: string }>;
    }>(stdout).data!;
    expect(data.stale.length).toBe(1);
    expect(data.stale[0].verifiedAt).toBe('2020-01-01');
    expect(data.issues[0].check).toBe('stale_verification');
    expect(data.issues[0].severity).toBe('warn');
  });

  it('flags a file on its oldest stamp and reports the newest', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await writeKnowledgeFile(
      conceptionPath,
      'topics/sectioned.md',
      `# Sectioned\n\n**Verified:** ${today} condash@fresh on main\n\n## Old bit\n\n**Verified:** 2020-01-01 ancient@deadbeef on main\n`,
    );
    const { stdout } = await captureStdout(() =>
      runKnowledge(
        'verify',
        { noun: 'knowledge', verb: 'verify', positional: [], flags: { 'max-age': '90' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{
      stale: Array<{
        relPath: string;
        verifiedAt: string;
        line: number;
        stampCount: number;
        newest: { verifiedAt: string; line: number };
      }>;
      fresh: number;
    }>(stdout).data!;
    // One entry for the file, judged on the old section — not "fresh" because
    // the header happens to be today's.
    expect(data.fresh).toBe(0);
    expect(data.stale).toHaveLength(1);
    expect(data.stale[0]).toMatchObject({
      verifiedAt: '2020-01-01',
      line: 7,
      stampCount: 2,
    });
    expect(data.stale[0].newest).toMatchObject({ verifiedAt: today, line: 3 });
  });
});

describe('knowledge retrieve', () => {
  it('grep mode finds full-text matches', async () => {
    await writeKnowledgeFile(
      conceptionPath,
      'topics/animals.md',
      '# Animals\n\nA banana is yellow.\nA lemon is also yellow.\n',
    );
    const { stdout, threw } = await captureStdout(() =>
      runKnowledge(
        'retrieve',
        {
          noun: 'knowledge',
          verb: 'retrieve',
          positional: ['banana'],
          flags: { mode: 'grep' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      triageMatches: unknown[];
      grepMatches: Array<{ snippet: string; line: number }>;
    }>(stdout).data!;
    expect(data.grepMatches.length).toBe(1);
    expect(data.grepMatches[0].snippet).toMatch(/banana/);
  });

  it('both mode still greps when triage matched — a keyword hit must not suppress it', async () => {
    // The regression: grep only ran when triage came back empty, so one
    // incidental keyword match hid the layer that had the answer.
    await writeKnowledgeFile(
      conceptionPath,
      'topics/animals.md',
      '# Animals\n\nA banana is yellow.\n',
    );
    await writeKnowledgeFile(
      conceptionPath,
      'index.md',
      '# Knowledge\n\n- [`Animals`](topics/animals.md) — *Yellow fruit.* `[banana, fruit]`\n',
    );
    const { stdout } = await captureStdout(() =>
      runKnowledge(
        'retrieve',
        {
          noun: 'knowledge',
          verb: 'retrieve',
          positional: ['banana'],
          flags: { mode: 'both' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{
      triageMatches: unknown[];
      grepMatches: Array<{ snippet: string }>;
    }>(stdout).data!;
    expect(data.triageMatches.length).toBeGreaterThan(0);
    expect(data.grepMatches.length).toBeGreaterThan(0);
  });

  it('USAGE error when query is empty', async () => {
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'retrieve',
        { noun: 'knowledge', verb: 'retrieve', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('USAGE error when --mode is invalid', async () => {
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'retrieve',
        {
          noun: 'knowledge',
          verb: 'retrieve',
          positional: ['x'],
          flags: { mode: 'fancy' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('knowledge stamp', () => {
  it('prepends a **Verified:** line when none exists', async () => {
    const path = await writeKnowledgeFile(conceptionPath, 'topics/foo.md', '# Foo\n\nBody.\n');
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'stamp',
        {
          noun: 'knowledge',
          verb: 'stamp',
          positional: [path],
          flags: { where: 'condash@abc1234 on main', date: '2026-05-17' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const updated = await fs.readFile(path, 'utf8');
    expect(updated.startsWith('**Verified:** 2026-05-17 condash@abc1234 on main')).toBe(true);
  });

  it('replaces an existing stamp idempotently', async () => {
    const path = await writeKnowledgeFile(
      conceptionPath,
      'topics/foo.md',
      '**Verified:** 2026-01-01 stale@deadbeef on main\n\n# Foo\n\nBody.\n',
    );
    await captureStdout(() =>
      runKnowledge(
        'stamp',
        {
          noun: 'knowledge',
          verb: 'stamp',
          positional: [path],
          flags: { where: 'condash@new on main', date: '2026-05-17' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const updated = await fs.readFile(path, 'utf8');
    expect(updated.startsWith('**Verified:** 2026-05-17 condash@new on main')).toBe(true);
    expect(updated).not.toMatch(/2026-01-01/);
  });

  it('refuses to guess which stamp to replace in a multi-stamp file', async () => {
    // `verify` flags the oldest stamp wherever it sits, so silently rewriting
    // the first one would refresh a line nobody re-read (condash#512).
    const path = await writeKnowledgeFile(
      conceptionPath,
      'topics/foo.md',
      '**Verified:** 2026-08-14 head\n\n# Foo\n\n## Old\n\n**Verified:** 2026-01-01 section\n',
    );
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'stamp',
        {
          noun: 'knowledge',
          verb: 'stamp',
          positional: [path],
          flags: { where: 'condash@new on main', date: '2026-08-18' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
    expect((threw as CliError).message).toContain('--line');
    // Nothing was written.
    expect(await fs.readFile(path, 'utf8')).toContain('**Verified:** 2026-01-01 section');
  });

  it('replaces the stamp on the line --line names', async () => {
    const path = await writeKnowledgeFile(
      conceptionPath,
      'topics/foo.md',
      '**Verified:** 2026-08-14 head\n\n# Foo\n\n## Old\n\n**Verified:** 2026-01-01 section\n',
    );
    const { stdout, threw } = await captureStdout(() =>
      runKnowledge(
        'stamp',
        {
          noun: 'knowledge',
          verb: 'stamp',
          positional: [path],
          flags: { where: 'condash@new on main', date: '2026-08-18', line: '7' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    expect(parseJsonEnvelope<{ line: number }>(stdout).data!.line).toBe(7);
    const updated = await fs.readFile(path, 'utf8');
    // The named section stamp moved; the header stamp is untouched.
    expect(updated).toContain('**Verified:** 2026-08-18 condash@new on main');
    expect(updated).toContain('**Verified:** 2026-08-14 head');
    expect(updated).not.toContain('2026-01-01');
  });

  it('NOT_FOUND when --line names a line that carries no stamp', async () => {
    const path = await writeKnowledgeFile(
      conceptionPath,
      'topics/foo.md',
      '**Verified:** 2026-08-14 head\n\n# Foo\n\n**Verified:** 2026-01-01 section\n',
    );
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'stamp',
        {
          noun: 'knowledge',
          verb: 'stamp',
          positional: [path],
          flags: { where: 'x', line: '3' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(4);
  });

  it('VALIDATION error when --date is not YYYY-MM-DD', async () => {
    const path = await writeKnowledgeFile(conceptionPath, 'topics/foo.md', '# Foo\n');
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'stamp',
        {
          noun: 'knowledge',
          verb: 'stamp',
          positional: [path],
          flags: { where: 'x', date: 'yesterday' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
  });

  it('VALIDATION error when target resolves outside the conception tree', async () => {
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'stamp',
        {
          noun: 'knowledge',
          verb: 'stamp',
          positional: ['../escape.md'],
          flags: { where: 'x' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
  });
});

describe('knowledge index', () => {
  it('--dry-run reports changes without writing', async () => {
    await writeKnowledgeFile(
      conceptionPath,
      'topics/alpha.md',
      '# Alpha\n\n*One line of summary.*\n',
    );
    const { stdout, threw } = await captureStdout(() =>
      runKnowledge(
        'index',
        {
          noun: 'knowledge',
          verb: 'index',
          positional: [],
          flags: { 'dry-run': true },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ dryRun: boolean }>(stdout).data!;
    expect(data.dryRun).toBe(true);
    // No `topics/index.md` should exist when dry-run.
    let topicsIndexExists = true;
    try {
      await fs.access(join(conceptionPath, 'knowledge', 'topics', 'index.md'));
    } catch {
      topicsIndexExists = false;
    }
    expect(topicsIndexExists).toBe(false);
  });
});

describe('runKnowledge dispatch', () => {
  it('rejects an unknown verb with USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runKnowledge(
        'banana',
        { noun: 'knowledge', verb: 'banana', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('prints help when verb is null', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runKnowledge(
        null,
        { noun: 'knowledge', verb: '', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash knowledge/);
  });
});
