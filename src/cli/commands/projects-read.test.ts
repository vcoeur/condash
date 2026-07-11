/**
 * Handler-level tests for projects-read.ts: list / read / resolve / search /
 * validate. Runs against tmp conceptions scaffolded via test-helpers, asserts
 * on the `--json` envelope.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listProjects,
  readProject,
  resolveCommand,
  searchProjects,
  validateCommand,
} from './projects-read';
import {
  captureStdout,
  humanCtx,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
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

async function seedThreeProjects(): Promise<void> {
  await writeProjectReadme(conceptionPath, 'alpha', {
    date: '2026-05-01',
    kind: 'project',
    status: 'now',
    apps: ['condash'],
    branch: 'review/alpha',
    base: 'main',
    title: 'Alpha project',
    body: '## Goal\n\nAlpha goal text.\n\n## Steps\n\n- [ ] step one\n- [x] step two\n',
  });
  await writeProjectReadme(conceptionPath, 'beta', {
    date: '2026-05-02',
    kind: 'incident',
    status: 'review',
    apps: ['vcoeur'],
    title: 'Beta incident',
    body: '## Goal\n\nBeta details.\n',
  });
  await writeProjectReadme(conceptionPath, 'gamma', {
    date: '2026-05-03',
    kind: 'project',
    status: 'done',
    apps: ['condash', 'vcoeur'],
    title: 'Gamma done',
    body: '## Goal\n\nGamma details.\n\n## Timeline\n\n- 2026-05-04 — Closed.\n',
  });
}

describe('listProjects', () => {
  it('returns rows for every project, sorted by status default', async () => {
    await seedThreeProjects();
    const { stdout, threw } = await captureStdout(() =>
      listProjects(
        { noun: 'projects', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const envelope = parseJsonEnvelope<unknown[]>(stdout);
    expect(envelope.ok).toBe(true);
    const rows = envelope.data as Array<{ slug: string; status: string; apps: string[] }>;
    expect(rows.map((r) => r.slug)).toEqual([
      '2026-05-01-alpha', // now
      '2026-05-02-beta', // review
      '2026-05-03-gamma', // done
    ]);
    expect(rows[0].apps).toEqual(['condash']);
  });

  it('filters by status', async () => {
    await seedThreeProjects();
    const { stdout } = await captureStdout(() =>
      listProjects(
        { noun: 'projects', verb: 'list', positional: [], flags: { status: 'done' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const rows = parseJsonEnvelope<unknown[]>(stdout).data as Array<{ slug: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('2026-05-03-gamma');
  });

  it('filters by apps (any-of)', async () => {
    await seedThreeProjects();
    const { stdout } = await captureStdout(() =>
      listProjects(
        { noun: 'projects', verb: 'list', positional: [], flags: { apps: 'vcoeur' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const rows = parseJsonEnvelope<unknown[]>(stdout).data as Array<{ slug: string }>;
    expect(rows.map((r) => r.slug).sort()).toEqual(['2026-05-02-beta', '2026-05-03-gamma']);
  });

  it('filters by branch (exact match)', async () => {
    await seedThreeProjects();
    const { stdout } = await captureStdout(() =>
      listProjects(
        { noun: 'projects', verb: 'list', positional: [], flags: { branch: 'review/alpha' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const rows = parseJsonEnvelope<unknown[]>(stdout).data as Array<{ slug: string }>;
    expect(rows.map((r) => r.slug)).toEqual(['2026-05-01-alpha']);
  });

  it('sorts by --sort date', async () => {
    await seedThreeProjects();
    const { stdout } = await captureStdout(() =>
      listProjects(
        { noun: 'projects', verb: 'list', positional: [], flags: { sort: 'date' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const rows = parseJsonEnvelope<unknown[]>(stdout).data as Array<{ slug: string; date: string }>;
    // `date` sort is descending — most recent first.
    expect(rows.map((r) => r.date)).toEqual(['2026-05-03', '2026-05-02', '2026-05-01']);
  });

  it('returns empty array when no projects match', async () => {
    const { stdout } = await captureStdout(() =>
      listProjects(
        { noun: 'projects', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const rows = parseJsonEnvelope<unknown[]>(stdout).data;
    expect(rows).toEqual([]);
  });

  it('emits POSIX relative paths in the JSON envelope (C5)', async () => {
    await seedThreeProjects();
    const { stdout } = await captureStdout(() =>
      listProjects(
        { noun: 'projects', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const rows = parseJsonEnvelope<unknown[]>(stdout).data as Array<{
      path: string;
      absPath: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.path).not.toContain('\\');
      expect(row.path).toMatch(/^projects\/\d{4}-\d{2}\/[^/]+$/);
      // absPath stays native (absolute filesystem path).
      expect(row.absPath.startsWith(conceptionPath)).toBe(true);
    }
  });

  it('reads each README exactly once (P1-13 — no double-read)', async () => {
    await seedThreeProjects();
    const origReadFile = fs.readFile;
    const readCounts = new Map<string, number>();
    const fsAny = fs as unknown as { readFile: typeof origReadFile };
    fsAny.readFile = (async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('/README.md')) {
        readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
      }
      return origReadFile(path as Parameters<typeof origReadFile>[0], ...(rest as never[]));
    }) as typeof origReadFile;

    try {
      await captureStdout(() =>
        listProjects(
          { noun: 'projects', verb: 'list', positional: [], flags: {} },
          jsonCtx(),
          conceptionPath,
        ),
      );
    } finally {
      fsAny.readFile = origReadFile;
    }
    for (const [path, count] of readCounts) {
      expect(count, `README read more than once: ${path}`).toBe(1);
    }
    expect(readCounts.size).toBe(3);
  });
});

describe('readProject', () => {
  it('returns full record for a slug', async () => {
    await seedThreeProjects();
    const { stdout, threw } = await captureStdout(() =>
      readProject(
        { noun: 'projects', verb: 'read', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<Record<string, unknown>>(stdout).data!;
    expect(data.title).toBe('Alpha project');
    expect(data.kind).toBe('project');
    expect(data.status).toBe('now');
    expect(data.branch).toBe('review/alpha');
    expect(data.base).toBe('main');
    expect(data.date).toBe('2026-05-01');
  });

  it('USAGE error when slug positional is missing', async () => {
    const { threw } = await captureStdout(() =>
      readProject(
        { noun: 'projects', verb: 'read', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('NOT_FOUND when slug matches nothing', async () => {
    await seedThreeProjects();
    const { threw } = await captureStdout(() =>
      readProject(
        { noun: 'projects', verb: 'read', positional: ['no-such-thing'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(4);
  });

  it('--with-notes folds notes/ markdown into the data record', async () => {
    await seedThreeProjects();
    const notesDir = join(conceptionPath, 'projects', '2026-05', '2026-05-01-alpha', 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(join(notesDir, '01-design.md'), '# Design\n\nBody.\n', 'utf8');

    const { stdout } = await captureStdout(() =>
      readProject(
        { noun: 'projects', verb: 'read', positional: ['alpha'], flags: { 'with-notes': true } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<Record<string, unknown>>(stdout).data!;
    const notes = data.notes as Array<{ relPath: string; content: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].relPath).toBe('notes/01-design.md');
    expect(notes[0].content).toContain('# Design');
  });
});

describe('resolveCommand', () => {
  it('prints absolute path for a unique slug', async () => {
    await seedThreeProjects();
    const { stdout, threw } = await captureStdout(() =>
      resolveCommand(
        { noun: 'projects', verb: 'resolve', positional: ['beta'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ absPath: string; slug: string }>(stdout).data!;
    expect(data.slug).toBe('2026-05-02-beta');
    expect(data.absPath).toMatch(/2026-05-02-beta$/);
  });

  it('throws AMBIGUOUS when slug matches more than one item', async () => {
    await seedThreeProjects();
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-06-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha 2',
    });
    const { threw } = await captureStdout(() =>
      resolveCommand(
        { noun: 'projects', verb: 'resolve', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(6);
  });
});

describe('searchProjects', () => {
  it('returns hits with the query echoed back', async () => {
    await seedThreeProjects();
    const { stdout, threw } = await captureStdout(() =>
      searchProjects(
        { noun: 'projects', verb: 'search', positional: ['Beta'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ query: string; hits: unknown[] }>(stdout).data!;
    expect(data.query).toBe('Beta');
    expect(data.hits.length).toBeGreaterThan(0);
  });

  it('USAGE error when query is empty', async () => {
    const { threw } = await captureStdout(() =>
      searchProjects(
        { noun: 'projects', verb: 'search', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('validateCommand', () => {
  it('reports OK when README is well-formed (human mode)', async () => {
    await seedThreeProjects();
    const { stdout, threw } = await captureStdout(() =>
      validateCommand(
        { noun: 'projects', verb: 'validate', positional: ['alpha'], flags: {} },
        humanCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/OK \(1 README checked\)/);
  });

  it('throws VALIDATION when --all and one README is malformed', async () => {
    await writeProjectReadme(conceptionPath, 'good', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Good',
    });
    // Malformed: status not in the enum → exit-3 error per validateHeader.
    await writeProjectReadme(conceptionPath, 'bad', {
      date: '2026-05-02',
      kind: 'project',
      status: 'banana',
      title: 'Bad',
    });

    const { threw } = await captureStdout(() =>
      validateCommand(
        { noun: 'projects', verb: 'validate', positional: [], flags: { all: true } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
  });

  it('rejects --path pointing outside <conception>/projects/', async () => {
    const { threw } = await captureStdout(() =>
      validateCommand(
        {
          noun: 'projects',
          verb: 'validate',
          positional: [],
          flags: { path: '../etc/passwd' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('USAGE error when no slug, --all, or --path is given', async () => {
    const { threw } = await captureStdout(() =>
      validateCommand(
        { noun: 'projects', verb: 'validate', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});
