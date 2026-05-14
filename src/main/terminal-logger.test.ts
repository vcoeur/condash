import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';
import {
  SessionLogger,
  type SessionContext,
  resolveLoggingPrefs,
  sessionLogPath,
  sessionMetaPath,
  type SessionMeta,
} from './terminal-logger';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-logger-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readMeta(path: string): SessionMeta {
  return JSON.parse(readFileSync(path, 'utf8')) as SessionMeta;
}

/** Default-on logger for tests. Production defaults to `enabled: false`
 * (opt-in for privacy); most tests in this file want the writer running
 * and merge their own scrollback / flushMs overrides on top. */
function makeLogger(
  tmpRoot: string,
  ctx: SessionContext,
  prefs: TerminalLoggingPrefs = {},
  flushMs?: number,
): SessionLogger {
  return new SessionLogger(tmpRoot, ctx, { enabled: true, ...prefs }, flushMs);
}

describe('sessionLogPath', () => {
  it('builds YYYY/MM/DD/HHMMSS-<sid>.txt under <conception>/.condash/logs', () => {
    const path = sessionLogPath('/x/conception', 't-abc', new Date('2026-05-13T14:22:07Z'));
    expect(path.startsWith(condashLogsRoot('/x/conception'))).toBe(true);
    expect(path).toMatch(/[/]\d{4}[/]\d{2}[/]\d{2}[/]\d{6}-t-abc\.txt$/);
  });
});

describe('sessionMetaPath', () => {
  it('replaces .txt with .meta.json', () => {
    expect(sessionMetaPath('/a/b/123456-sid.txt')).toBe('/a/b/123456-sid.meta.json');
  });
});

describe('resolveLoggingPrefs', () => {
  it('returns defaults when patch is empty — enabled defaults to false (opt-in)', () => {
    const p = resolveLoggingPrefs({});
    expect(p.enabled).toBe(false);
    expect(p.scrollback).toBe(10000);
    expect(p.maxDirMb).toBe(500);
    expect(p.retentionDays).toBe(14);
  });

  it('overrides only the specified keys', () => {
    const p = resolveLoggingPrefs({ scrollback: 2000 });
    expect(p.scrollback).toBe(2000);
    expect(p.enabled).toBe(false);
    expect(p.retentionDays).toBe(14);
  });

  it('enabled: true patch turns capture on', () => {
    const p = resolveLoggingPrefs({ enabled: true });
    expect(p.enabled).toBe(true);
  });
});

describe('SessionLogger', () => {
  it('writes .meta.json on spawn() and a rendered .txt after output()', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-abc',
        side: 'my',
        cwd: '/home/alice',
        spawn: { cmd: '/bin/bash', argv: ['-l'] },
      },
      {},
      // Short flush window so tests don't wait the full 5 s.
      50,
    );
    logger.spawn();
    logger.output('hello world\r\n');
    await logger.flushForTests();
    logger.exit(0);
    await logger.close();

    const txt = logger.filePath();
    expect(txt).not.toBeNull();
    if (!txt) return;
    expect(existsSync(txt)).toBe(true);

    const text = readFileSync(txt, 'utf8');
    expect(text).toContain('hello world');

    const meta = readMeta(sessionMetaPath(txt));
    expect(meta.sid).toBe('t-abc');
    expect(meta.cmd).toBe('/bin/bash');
    expect(meta.argv).toEqual(['-l']);
    expect(meta.cwd).toBe('/home/alice');
    expect(meta.exitCode).toBe(0);
    expect(meta.finished).toBeTypeOf('string');
    expect(meta.started).toBeTypeOf('string');
  });

  it('files land at <conception>/.condash/logs/YYYY/MM/DD/', async () => {
    const logger = makeLogger(tmp, {
      sid: 't-xyz',
      side: 'code',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    await logger.close();
    const path = logger.filePath();
    expect(path).not.toBeNull();
    if (!path) return;
    expect(path.startsWith(join(tmp, '.condash', 'logs'))).toBe(true);
    expect(path).toMatch(/[/]\d{6}-t-xyz\.txt$/);
  });

  it('drops input() — no extra file, no doubled output', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-noin',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      50,
    );
    logger.spawn();
    // Caller emits both because the pty echoes keystrokes back as output.
    // The writer should record the echo (output) only — the typed bytes
    // (input) are intentionally dropped to avoid doubling and to keep
    // keystrokes off disk.
    logger.input('ls\r');
    logger.output('ls\r\n');
    await logger.flushForTests();
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const text = readFileSync(txt, 'utf8');
    // The line should appear exactly once.
    const matches = text.match(/ls/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('atomic write — no stale .tmp file remains', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-atom',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      50,
    );
    logger.spawn();
    logger.output('content');
    await logger.flushForTests();
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    expect(existsSync(txt)).toBe(true);
    expect(existsSync(`${txt}.tmp`)).toBe(false);
    expect(existsSync(`${sessionMetaPath(txt)}.tmp`)).toBe(false);
  });

  it('updates meta exitCode + finished on exit()', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-ex',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      50,
    );
    logger.spawn();
    logger.output('done');
    logger.exit(137);
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const meta = readMeta(sessionMetaPath(txt));
    expect(meta.exitCode).toBe(137);
    expect(meta.finished).toBeTypeOf('string');
  });

  it('debounces flush — multiple outputs in one window produce one write cycle', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-debounce',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      50,
    );
    logger.spawn();
    for (let i = 0; i < 10; i++) logger.output(`line ${i}\r\n`);
    // Before the debounce fires, the .txt may not exist yet.
    await logger.flushForTests();
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const text = readFileSync(txt, 'utf8');
    for (let i = 0; i < 10; i++) {
      expect(text).toContain(`line ${i}`);
    }
  });

  it('does nothing when enabled is false', async () => {
    const logger = new SessionLogger(
      tmp,
      {
        sid: 't-off',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      { enabled: false },
      50,
    );
    logger.spawn();
    logger.output('hello');
    logger.exit(0);
    await logger.close();
    // Path returns the canonical position regardless, but no file should
    // have been written.
    const txt = logger.filePath();
    expect(txt).not.toBeNull();
    if (!txt) return;
    expect(existsSync(txt)).toBe(false);
    expect(existsSync(sessionMetaPath(txt))).toBe(false);
  });

  it('preserves ANSI escapes in the .txt — reader-side ansi_up turns them into styled HTML', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-ansi',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      50,
    );
    logger.spawn();
    logger.output('\x1b[31mred\x1b[0m\r\n');
    await logger.flushForTests();
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const text = readFileSync(txt, 'utf8');
    // The visible text is preserved; SGR codes survive somewhere in the
    // serialised buffer so the renderer can colour the output. We don't
    // pin the exact escape sequence (xterm normalises some forms) — only
    // that the rendered text appears and that *some* SGR escape is present.
    expect(text).toContain('red');
    expect(text).toMatch(/\x1b\[/);
  });

  it('rendered file size is bounded by scrollback × line width', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-bound',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      { scrollback: 200 },
      50,
    );
    logger.spawn();
    // Pump 5000 lines through — the headless terminal scrollback caps at
    // 200, so the rendered .txt should hold no more than ~200 lines.
    for (let i = 0; i < 5000; i++) logger.output(`line ${i}\r\n`);
    await logger.flushForTests();
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const text = readFileSync(txt, 'utf8');
    // Count visible-line markers — stripping ANSI to be tolerant of any
    // styling the writer added.
    const stripped = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const lineMatches = stripped.match(/line \d+/g) ?? [];
    // Headless rows + scrollback gives an upper bound; allow generous
    // slack (rows + scrollback + 10) so test stays robust if xterm's
    // internal trimming policy shifts.
    expect(lineMatches.length).toBeLessThanOrEqual(300);
    // Sanity: at least *some* lines made it.
    expect(lineMatches.length).toBeGreaterThan(0);
    // Stat-based size guard: even with worst-case ANSI inflation, far
    // below what 5000 lines of raw output would have produced.
    expect(statSync(txt).size).toBeLessThan(200 * 1024);
  });
});
