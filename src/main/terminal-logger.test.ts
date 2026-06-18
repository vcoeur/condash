import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';
import {
  SessionLogger,
  type SessionContext,
  META_LINE_PREFIX,
  resolveLoggingPrefs,
  sessionLogPath,
} from './terminal-logger';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-logger-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface HeaderJson {
  sid: string;
  cmd: string;
  argv: string[];
  cwd: string;
  started: string;
  repo?: string;
}

interface FooterJson {
  finished: string;
  exitCode: number;
}

/** Parse the on-disk `.txt`: header line, blank, body, optional blank +
 * footer line. Mirrors `ipc/logs.ts:splitContent`. */
function parseFile(txtPath: string): {
  header: HeaderJson | null;
  body: string;
  footer: FooterJson | null;
} {
  const raw = readFileSync(txtPath, 'utf8');
  const allLines = raw.split('\n');
  let header: HeaderJson | null = null;
  let start = 0;
  if (allLines.length > 0 && allLines[0].startsWith(META_LINE_PREFIX)) {
    header = JSON.parse(allLines[0].slice(META_LINE_PREFIX.length)) as HeaderJson;
    start = 1;
    if (start < allLines.length && allLines[start] === '') start++;
  }
  let end = allLines.length;
  let footer: FooterJson | null = null;
  if (end > start && allLines[end - 1] === '') end--;
  if (end > start && allLines[end - 1].startsWith(META_LINE_PREFIX)) {
    const parsed = JSON.parse(allLines[end - 1].slice(META_LINE_PREFIX.length));
    if ('exitCode' in parsed || 'finished' in parsed) {
      footer = parsed as FooterJson;
      end--;
      if (end > start && allLines[end - 1] === '') end--;
    }
  }
  return { header, body: allLines.slice(start, end).join('\n'), footer };
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

  it('routes a manual task run out of logs/ into .condash/manual/<slug>/', () => {
    const path = sessionLogPath('/x/conception', 't-abc', new Date('2026-05-13T14:22:07Z'), {
      taskSlug: 'sample-task',
      trigger: 'manual',
    });
    expect(path.startsWith(condashLogsRoot('/x/conception'))).toBe(false);
    expect(path).toContain('/.condash/manual/sample-task/');
    expect(path).toMatch(/[/]\d{8}-\d{6}-t-abc\.txt$/);
  });

  it('routes a scheduled task run into .condash/scheduled/<slug>/ — never logs/', () => {
    const path = sessionLogPath('/x/conception', 't-xyz', new Date('2026-05-13T14:22:07Z'), {
      taskSlug: 'sample-task',
      trigger: 'scheduled',
    });
    expect(path.startsWith(condashLogsRoot('/x/conception'))).toBe(false);
    expect(path).toContain('/.condash/scheduled/sample-task/');
  });
});

describe('resolveLoggingPrefs', () => {
  it('returns defaults when patch is empty — enabled defaults to false (opt-in)', () => {
    const p = resolveLoggingPrefs({});
    expect(p.enabled).toBe(false);
    expect(p.scrollback).toBe(5000);
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
  it('writes header line on spawn and body + footer after exit', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-abc',
        side: 'my',
        cwd: '/home/alice',
        spawn: { cmd: '/bin/bash', argv: ['-l'] },
      },
      {},
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

    const { header, body, footer } = parseFile(txt);
    expect(header).not.toBeNull();
    expect(header?.sid).toBe('t-abc');
    expect(header?.cmd).toBe('/bin/bash');
    expect(header?.argv).toEqual(['-l']);
    expect(header?.cwd).toBe('/home/alice');
    expect(header?.started).toBeTypeOf('string');
    expect(body).toContain('hello world');
    expect(footer).not.toBeNull();
    expect(footer?.exitCode).toBe(0);
    expect(footer?.finished).toBeTypeOf('string');
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
    const { body } = parseFile(txt);
    const matches = body.match(/ls/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('atomic write — no stale .tmp file remains, no sidecar at all', async () => {
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
    expect(existsSync(txt.replace(/\.txt$/, '.meta.json'))).toBe(false);
  });

  it('records exitCode + finished in the footer on exit()', async () => {
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
    const { footer } = parseFile(txt);
    expect(footer?.exitCode).toBe(137);
    expect(footer?.finished).toBeTypeOf('string');
  });

  it('no footer line until exit() — in-flight sessions only carry the header', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-inflight',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      50,
    );
    logger.spawn();
    logger.output('still running');
    await logger.flushForTests();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { header, footer } = parseFile(txt);
    expect(header).not.toBeNull();
    expect(footer).toBeNull();
    await logger.close();
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
    await logger.flushForTests();
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    for (let i = 0; i < 10; i++) {
      expect(body).toContain(`line ${i}`);
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
    const txt = logger.filePath();
    expect(txt).not.toBeNull();
    if (!txt) return;
    expect(existsSync(txt)).toBe(false);
  });

  it('strips SGR escapes — body is plain text', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-plain',
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
    const { body } = parseFile(txt);
    expect(body).toContain('red');
    // No raw ESC bytes survive into the body — the headless xterm
    // resolved the SGR codes into glyph attributes we don't render.
    expect(body).not.toMatch(/\x1b\[/);
  });

  it('close() drains output that races the close — no tail bytes dropped', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-race',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      5,
    );
    logger.spawn();
    logger.output('first line\r\n');
    // Start closing, then emit more output while the close is draining — the
    // single-pass close used to mark `closed` and silently drop these bytes.
    const closing = logger.close();
    logger.output('tail bytes\r\n');
    await closing;

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    expect(body).toContain('first line');
    expect(body).toContain('tail bytes');
  });

  it('close() is idempotent under concurrent callers', async () => {
    const logger = makeLogger(
      tmp,
      {
        sid: 't-dupclose',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      5,
    );
    logger.spawn();
    logger.output('once\r\n');
    logger.exit(0);
    await Promise.all([logger.close(), logger.close(), logger.close()]);
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body, footer } = parseFile(txt);
    expect(body).toContain('once');
    expect(footer?.exitCode).toBe(0);
  });

  it('close() persists the final buffer even when exit() never ran (kill path)', async () => {
    // The quit / SIGKILL path closes a logger without an exit() — the forced
    // final flush in doClose() must still land the output (with no footer,
    // since the session never reported an exit code).
    const logger = makeLogger(
      tmp,
      {
        sid: 't-killpath',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      {},
      // Large debounce so no periodic flush fires — only doClose's flush writes.
      60_000,
    );
    logger.spawn();
    logger.output('output never explicitly flushed\r\n');
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body, footer } = parseFile(txt);
    expect(body).toContain('output never explicitly flushed');
    expect(footer).toBeNull();
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
    for (let i = 0; i < 5000; i++) logger.output(`line ${i}\r\n`);
    await logger.flushForTests();
    await logger.close();

    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    const lineMatches = body.match(/line \d+/g) ?? [];
    expect(lineMatches.length).toBeLessThanOrEqual(300);
    expect(lineMatches.length).toBeGreaterThan(0);
    expect(statSync(txt).size).toBeLessThan(200 * 1024);
  });
});

describe('SessionLogger timestamp markers', () => {
  const PREFIX = '\x1b]7373;agent-transcript;';
  const BEL = '\x07';
  /** One single-packet `msg` OSC frame, as a cooperating harness emits it. */
  function msgPacket(id: string, role: string, text: string): string {
    const b64 = Buffer.from(JSON.stringify({ v: 1, t: 'msg', role, text }), 'utf8').toString(
      'base64',
    );
    return `${PREFIX}${id};0;1;${b64}${BEL}`;
  }

  const ctx: SessionContext = {
    sid: 't-ts',
    side: 'my',
    cwd: '/x',
    spawn: { cmd: 'bash', argv: [] },
  };

  /** A logger with an injected clock; `clockRef.now` is read on every tick. */
  function makeClockedLogger(clockRef: { now: Date }, markerIntervalSec: number): SessionLogger {
    return new SessionLogger(
      tmp,
      ctx,
      { enabled: true, markerIntervalSec },
      50,
      () => clockRef.now,
    );
  }

  const MARKER_RE = /<!-- \d{4}-\d{2}-\d{2}:\d{2}:\d{2} -->/g;

  it('grid: no marker before the interval elapses', async () => {
    const clk = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const logger = makeClockedLogger(clk, 60);
    logger.spawn();
    logger.output('one\r\n');
    await logger.flushForTests();
    clk.now = new Date(2026, 4, 30, 20, 0, 30); // +30s, under the 60s interval
    logger.output('two\r\n');
    await logger.flushForTests();
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    expect(body).not.toContain('<!-- timeline -->');
    expect(body).not.toMatch(MARKER_RE);
  });

  it('grid: emits a marker once the interval elapses with new content (trailing timeline)', async () => {
    const clk = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const logger = makeClockedLogger(clk, 60);
    logger.spawn();
    logger.output('one\r\n');
    await logger.flushForTests(); // elapsed 0 → no marker
    clk.now = new Date(2026, 4, 30, 20, 1, 1); // +61s
    logger.output('two\r\n');
    await logger.flushForTests(); // marker due
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    expect(body).toContain('<!-- timeline -->');
    expect(body).toContain('<!-- 2026-05-30:20:01 -->');
    // grid markers trail the rendered buffer content
    expect(body.indexOf('one')).toBeLessThan(body.indexOf('<!-- timeline -->'));
  });

  it('grid: stamps at a regular cadence under continuous output', async () => {
    const clk = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const logger = makeClockedLogger(clk, 60);
    logger.spawn();
    logger.output('a\r\n');
    await logger.flushForTests(); // 20:00 → none
    clk.now = new Date(2026, 4, 30, 20, 1, 1);
    logger.output('b\r\n');
    await logger.flushForTests(); // 20:01
    clk.now = new Date(2026, 4, 30, 20, 2, 2);
    logger.output('c\r\n');
    await logger.flushForTests(); // 20:02
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    expect(body).toContain('<!-- 2026-05-30:20:01 -->');
    expect(body).toContain('<!-- 2026-05-30:20:02 -->');
  });

  it('grid: an idle exit flush after a marker adds no further marker', async () => {
    const clk = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const logger = makeClockedLogger(clk, 60);
    logger.spawn();
    logger.output('one\r\n');
    clk.now = new Date(2026, 4, 30, 20, 1, 1);
    logger.output('two\r\n');
    await logger.flushForTests(); // one marker at 20:01
    clk.now = new Date(2026, 4, 30, 20, 5, 0); // far past interval, but no new output
    logger.exit(0); // sets dirty, not contentSinceMarker
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    expect(body.match(MARKER_RE) ?? []).toHaveLength(1);
  });

  it('grid: resumption after a long gap stamps immediately on new content', async () => {
    const clk = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const logger = makeClockedLogger(clk, 60);
    logger.spawn();
    logger.output('one\r\n');
    clk.now = new Date(2026, 4, 30, 20, 1, 1);
    logger.output('two\r\n');
    await logger.flushForTests(); // marker at 20:01
    clk.now = new Date(2026, 4, 30, 20, 9, 0); // ~8 min gap
    logger.output('three\r\n');
    await logger.flushForTests(); // marker at 20:09, immediately
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    expect(body).toContain('<!-- 2026-05-30:20:01 -->');
    expect(body).toContain('<!-- 2026-05-30:20:09 -->');
  });

  it('transcript: marker is inline in the body, not a trailing grid block', async () => {
    const clk = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const logger = makeClockedLogger(clk, 60);
    logger.spawn();
    logger.output(msgPacket('a', 'user', 'first'));
    await logger.flushForTests(); // no marker (elapsed 0)
    clk.now = new Date(2026, 4, 30, 20, 1, 1);
    logger.output(msgPacket('b', 'assistant', 'second'));
    await logger.flushForTests(); // marker due
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { header, body } = parseFile(txt);
    expect((header as unknown as { kind?: string }).kind).toBe('transcript');
    expect(body).toContain('[user] first');
    expect(body).toContain('[assistant] second');
    expect(body).toContain('<!-- 2026-05-30:20:01 -->');
    expect(body).not.toContain('<!-- timeline -->');
  });

  it('markerIntervalSec: 0 disables periodic markers', async () => {
    const clk = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const logger = makeClockedLogger(clk, 0);
    logger.spawn();
    logger.output('one\r\n');
    await logger.flushForTests();
    clk.now = new Date(2026, 4, 30, 20, 30, 0); // +30 min
    logger.output('two\r\n');
    await logger.flushForTests();
    await logger.close();
    const txt = logger.filePath();
    if (!txt) throw new Error('no path');
    const { body } = parseFile(txt);
    expect(body).not.toContain('<!-- timeline -->');
    expect(body).not.toMatch(MARKER_RE);
  });
});
