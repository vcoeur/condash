import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { runLogs } from './logs';
import { ExitCodes } from '../output';
import {
  captureStdout,
  jsonCtx,
  humanCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  type JsonEnvelope,
} from './test-helpers';
import type { ParsedArgs } from '../parser';

interface SessionOpts {
  repo?: string;
  cwd?: string;
  cmd?: string;
  argv?: string[];
  started?: string;
  /** Add a footer with this exit code (omit → active session, no footer). */
  exitCode?: number;
  finished?: string;
  /** Stamp the header `kind` (omit → legacy log, readers fall back to heuristic). */
  kind?: 'transcript' | 'grid';
}

async function writeSession(
  conception: string,
  day: string,
  hms: string,
  sid: string,
  body: string[],
  opts: SessionOpts = {},
): Promise<string> {
  const [y, m, d] = day.split('-');
  const dir = join(conception, '.condash', 'logs', y, m, d);
  await fs.mkdir(dir, { recursive: true });
  const header = {
    sid,
    side: 'left',
    repo: opts.repo,
    cwd: opts.cwd,
    cmd: opts.cmd,
    argv: opts.argv,
    started: opts.started ?? `${day}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}Z`,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
  let raw = `# condash: ${JSON.stringify(header)}\n\n${body.join('\n')}\n`;
  if (opts.exitCode !== undefined) {
    const footer = { finished: opts.finished ?? `${day}T23:59:59Z`, exitCode: opts.exitCode };
    raw += `\n# condash: ${JSON.stringify(footer)}\n`;
  }
  const path = join(dir, `${hms}-${sid}.txt`);
  await fs.writeFile(path, raw, 'utf8');
  return path;
}

function args(
  verb: string,
  positional: string[],
  flags: Record<string, string | boolean>,
): {
  verb: string;
  parsed: ParsedArgs;
} {
  return { verb, parsed: { noun: 'logs', verb, positional, flags } };
}

let conception: string;
beforeEach(async () => {
  conception = await makeTmpConception();
});
afterEach(async () => {
  await rmConception(conception);
});

describe('logs days', () => {
  it('lists days newest-first with counts and sizes', async () => {
    await writeSession(conception, '2026-05-29', '100000', 't-aaaa1111', ['old']);
    await writeSession(conception, '2026-05-30', '120000', 't-bbbb2222', ['one', 'two']);
    await writeSession(conception, '2026-05-30', '130000', 't-cccc3333', ['x']);

    const { stdout } = await captureStdout(() =>
      runLogs(
        'days',
        { noun: 'logs', verb: 'days', positional: [], flags: {} },
        jsonCtx(),
        conception,
      ),
    );
    const data = parseJsonEnvelope<{ days: { day: string; sessions: number; bytes: number }[] }>(
      stdout,
    ).data!;
    expect(data.days.map((x) => x.day)).toEqual(['2026-05-30', '2026-05-29']);
    expect(data.days[0].sessions).toBe(2);
    expect(data.days[0].bytes).toBeGreaterThan(0);
  });

  it('narrows to a month', async () => {
    await writeSession(conception, '2026-04-30', '100000', 't-aaaa1111', ['april']);
    await writeSession(conception, '2026-05-30', '100000', 't-bbbb2222', ['may']);
    const { parsed, verb } = args('days', [], { month: '2026-05' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const data = parseJsonEnvelope<{ days: { day: string }[] }>(stdout).data!;
    expect(data.days.map((x) => x.day)).toEqual(['2026-05-30']);
  });

  it('reports empty when no logs exist', async () => {
    const { stdout } = await captureStdout(() =>
      runLogs(
        'days',
        { noun: 'logs', verb: 'days', positional: [], flags: {} },
        humanCtx(),
        conception,
      ),
    );
    expect(stdout).toContain('no session logs');
  });
});

describe('logs list', () => {
  beforeEach(async () => {
    await writeSession(conception, '2026-05-30', '090000', 't-aaaa1111', ['a'], {
      repo: 'condash',
      cwd: '/src/condash',
      cmd: 'npm',
      argv: ['run', 'dev'],
      exitCode: 0,
    });
    await writeSession(conception, '2026-05-30', '120000', 't-bbbb2222', ['b'], {
      repo: 'knoten',
    }); // active (no footer)
    await writeSession(conception, '2026-05-29', '100000', 't-cccc3333', ['c'], {
      repo: 'condash',
      exitCode: 0,
    });
  });

  it('lists all sessions newest spawn-time first', async () => {
    const { parsed, verb } = args('list', [], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: { sid: string; active: boolean }[] }>(stdout).data!
      .sessions;
    expect(rows.map((r) => r.sid)).toEqual(['t-bbbb2222', 't-aaaa1111', 't-cccc3333']);
    expect(rows.find((r) => r.sid === 't-bbbb2222')!.active).toBe(true);
    expect(rows.find((r) => r.sid === 't-aaaa1111')!.active).toBe(false);
  });

  it('filters by repo', async () => {
    const { parsed, verb } = args('list', [], { repo: 'condash' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: { sid: string }[] }>(stdout).data!.sessions;
    expect(rows.map((r) => r.sid).sort()).toEqual(['t-aaaa1111', 't-cccc3333']);
  });

  it('reports a kind on every row', async () => {
    await writeSession(conception, '2026-05-30', '130000', 't-dddd4444', ['[user] hi'], {
      repo: 'condash',
    });
    const { parsed, verb } = args('list', [], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: { sid: string; kind: string }[] }>(stdout).data!
      .sessions;
    expect(rows.find((r) => r.sid === 't-dddd4444')!.kind).toBe('transcript');
    expect(rows.find((r) => r.sid === 't-aaaa1111')!.kind).toBe('grid');
  });

  it('filters to active sessions', async () => {
    const { parsed, verb } = args('list', [], { active: true });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: { sid: string }[] }>(stdout).data!.sessions;
    expect(rows.map((r) => r.sid)).toEqual(['t-bbbb2222']);
  });

  it('filters by day positional', async () => {
    const { parsed, verb } = args('list', ['2026-05-29'], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: { sid: string }[] }>(stdout).data!.sessions;
    expect(rows.map((r) => r.sid)).toEqual(['t-cccc3333']);
  });

  it('filters by spawn time window', async () => {
    const { parsed, verb } = args('list', [], {
      since: '2026-05-30T10:00',
      until: '2026-05-30T23:59',
    });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: { sid: string }[] }>(stdout).data!.sessions;
    expect(rows.map((r) => r.sid)).toEqual(['t-bbbb2222']);
  });

  it('filters by modified-since using file mtime', async () => {
    // Push one file's mtime into the future and the rest into the past.
    const recent = join(
      conception,
      '.condash',
      'logs',
      '2026',
      '05',
      '30',
      '120000-t-bbbb2222.txt',
    );
    const old = new Date('2020-01-01T00:00:00Z');
    for (const p of [
      join(conception, '.condash', 'logs', '2026', '05', '30', '090000-t-aaaa1111.txt'),
      join(conception, '.condash', 'logs', '2026', '05', '29', '100000-t-cccc3333.txt'),
    ]) {
      await fs.utimes(p, old, old);
    }
    const now = new Date();
    await fs.utimes(recent, now, now);
    const { parsed, verb } = args('list', [], { 'modified-since': '1h' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: { sid: string }[] }>(stdout).data!.sessions;
    expect(rows.map((r) => r.sid)).toEqual(['t-bbbb2222']);
  });

  it('caps with --limit', async () => {
    const { parsed, verb } = args('list', [], { limit: '1' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const rows = parseJsonEnvelope<{ sessions: unknown[] }>(stdout).data!.sessions;
    expect(rows.length).toBe(1);
  });

  it('rejects a bad day positional with USAGE', async () => {
    const { parsed, verb } = args('list', ['2026/05/30'], {});
    const { threw } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect((threw as { exitCode?: number }).exitCode).toBe(ExitCodes.USAGE);
  });

  it('rejects a malformed --since with USAGE', async () => {
    const { parsed, verb } = args('list', [], { since: 'lunchtime' });
    const { threw } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect((threw as { exitCode?: number }).exitCode).toBe(ExitCodes.USAGE);
  });
});

describe('logs read', () => {
  beforeEach(async () => {
    await writeSession(
      conception,
      '2026-05-30',
      '120000',
      't-read1234',
      ['line1', 'line2', 'line3', 'line4', 'line5'],
      { repo: 'condash', cmd: 'bash', exitCode: 0 },
    );
  });

  it('outputs the whole body, meta stripped', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const data = parseJsonEnvelope<{ text: string; totalLines: number }>(stdout).data!;
    expect(data.text).toBe('line1\nline2\nline3\nline4\nline5');
    expect(data.totalLines).toBe(5);
    expect(data.text).not.toContain('# condash:');
  });

  it('honours --head', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], { head: '2' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ text: string }>(stdout).data!.text).toBe('line1\nline2');
  });

  it('honours --tail', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], { tail: '2' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ text: string }>(stdout).data!.text).toBe('line4\nline5');
  });

  it('honours --lines a-b', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], { lines: '2-4' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ text: string }>(stdout).data!.text).toBe('line2\nline3\nline4');
  });

  it('keeps meta lines with --with-meta', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], { 'with-meta': true });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ text: string }>(stdout).data!.text).toContain('# condash:');
  });

  it('--meta emits only metadata', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], { meta: true });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const data = parseJsonEnvelope<{ text: string; footer: { exitCode: number } }>(stdout).data!;
    expect(data.text).toBe('');
    expect(data.footer.exitCode).toBe(0);
  });

  it('--from-byte returns the appended slice and a nextByte cursor', async () => {
    // First, read whole to learn size, then ask for a cursor near the end.
    const whole = await captureStdout(() =>
      runLogs(
        'read',
        { noun: 'logs', verb: 'read', positional: ['t-read1234'], flags: {} },
        jsonCtx(),
        conception,
      ),
    );
    const size = parseJsonEnvelope<{ bytes: number; nextByte: number }>(whole.stdout).data!.bytes;
    // Cursor at the very end → empty delta, nextByte === size.
    const { parsed, verb } = args('read', ['t-read1234'], { 'from-byte': String(size) });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const data = parseJsonEnvelope<{ text: string; nextByte: number; rotated: boolean }>(
      stdout,
    ).data!;
    expect(data.text).toBe('');
    expect(data.nextByte).toBe(size);
    expect(data.rotated).toBe(false);
  });

  it('--from-byte past EOF flags rotation', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], { 'from-byte': '999999' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ rotated: boolean }>(stdout).data!.rotated).toBe(true);
  });

  it('reports kind=grid for a plain body (heuristic fallback)', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ kind: string }>(stdout).data!.kind).toBe('grid');
  });

  it('reports kind=transcript for a role-block body (heuristic fallback)', async () => {
    await writeSession(conception, '2026-05-30', '121000', 't-tx111111', [
      '[user] hello',
      '',
      '[assistant] hi there',
    ]);
    const { parsed, verb } = args('read', ['t-tx111111'], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ kind: string }>(stdout).data!.kind).toBe('transcript');
  });

  it('prefers the header-stamped kind over the heuristic', async () => {
    // Plain body, but header says transcript → header wins.
    await writeSession(conception, '2026-05-30', '122000', 't-kd111111', ['plain output'], {
      kind: 'transcript',
    });
    const { parsed, verb } = args('read', ['t-kd111111'], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ kind: string }>(stdout).data!.kind).toBe('transcript');
  });

  it('--redact masks secrets in the emitted body', async () => {
    await writeSession(conception, '2026-05-30', '123000', 't-sec11111', [
      'export API_KEY=supersecretvalue123',
      'plain line',
    ]);
    const { parsed, verb } = args('read', ['t-sec11111'], { redact: true });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const text = parseJsonEnvelope<{ text: string }>(stdout).data!.text;
    expect(text).toContain('API_KEY=«redacted:secret»');
    expect(text).not.toContain('supersecretvalue123');
    expect(text).toContain('plain line');
  });

  it('without --redact the body is emitted verbatim', async () => {
    await writeSession(conception, '2026-05-30', '123500', 't-sec22222', [
      'export API_KEY=supersecretvalue123',
    ]);
    const { parsed, verb } = args('read', ['t-sec22222'], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ text: string }>(stdout).data!.text).toContain('supersecretvalue123');
  });

  it('rejects two selectors as USAGE', async () => {
    const { parsed, verb } = args('read', ['t-read1234'], { head: '2', tail: '2' });
    const { threw } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect((threw as { exitCode?: number }).exitCode).toBe(ExitCodes.USAGE);
  });

  it('not-found for an unknown sid', async () => {
    const { parsed, verb } = args('read', ['t-nope'], {});
    const { threw } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect((threw as { exitCode?: number }).exitCode).toBe(ExitCodes.NOT_FOUND);
  });

  it('ambiguous prefix exits 6', async () => {
    await writeSession(conception, '2026-05-30', '130000', 't-read9999', ['other']);
    const { parsed, verb } = args('read', ['t-read'], {});
    const { threw } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect((threw as { exitCode?: number }).exitCode).toBe(ExitCodes.AMBIGUOUS);
  });

  it('exact sid wins over a longer-prefix sibling', async () => {
    await writeSession(conception, '2026-05-30', '130000', 't-read12345', ['sibling']);
    const { parsed, verb } = args('read', ['t-read1234'], { head: '1' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    expect(parseJsonEnvelope<{ text: string }>(stdout).data!.text).toBe('line1');
  });
});

describe('logs tail', () => {
  beforeEach(async () => {
    await writeSession(conception, '2026-05-30', '090000', 't-ended111', ['done1', 'done2'], {
      repo: 'condash',
      exitCode: 0,
    });
    await writeSession(
      conception,
      '2026-05-30',
      '120000',
      't-live2222',
      ['a', 'b', 'c', 'd', 'e'],
      { repo: 'knoten' },
    );
  });

  it('shows last lines of active sessions only by default', async () => {
    const { parsed, verb } = args('tail', [], { lines: '2' });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const ss = parseJsonEnvelope<{ sessions: { sid: string; lines: string[] }[] }>(stdout).data!
      .sessions;
    expect(ss.map((s) => s.sid)).toEqual(['t-live2222']);
    expect(ss[0].lines).toEqual(['d', 'e']);
  });

  it('--all includes ended sessions', async () => {
    const { parsed, verb } = args('tail', [], { all: true });
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, jsonCtx(), conception));
    const ss = parseJsonEnvelope<{ sessions: { sid: string }[] }>(stdout).data!.sessions;
    expect(ss.map((s) => s.sid).sort()).toEqual(['t-ended111', 't-live2222']);
  });

  it('reports no active sessions in human mode', async () => {
    // Remove the live one so only the ended session remains.
    await fs.rm(join(conception, '.condash', 'logs', '2026', '05', '30', '120000-t-live2222.txt'));
    const { parsed, verb } = args('tail', [], {});
    const { stdout } = await captureStdout(() => runLogs(verb, parsed, humanCtx(), conception));
    expect(stdout).toContain('no active sessions');
  });
});

describe('logs dispatch', () => {
  it('rejects an unknown verb with USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runLogs(
        'frobnicate',
        { noun: 'logs', verb: 'frobnicate', positional: [], flags: {} },
        jsonCtx(),
        conception,
      ),
    );
    expect((threw as { exitCode?: number }).exitCode).toBe(ExitCodes.USAGE);
  });

  it('prints help without touching the conception', async () => {
    const { stdout } = await captureStdout(() =>
      runLogs(
        'list',
        { noun: 'logs', verb: 'list', positional: [], flags: {} },
        humanCtx(),
        '',
        true,
      ),
    );
    expect(stdout).toContain('condash logs list');
  });
});

// Keep the JsonEnvelope import meaningful for type-checkers that prune unused.
export type _Env = JsonEnvelope;
