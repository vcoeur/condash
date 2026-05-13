import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { condashLogsRoot } from './condash-dir';
import { SessionLogger, resolveLoggingPrefs, sessionLogPath, stripAnsi } from './terminal-logger';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-logger-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readJsonl(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitForFlush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('sessionLogPath', () => {
  it('builds YYYY/MM/DD/HHMMSS-<sid>.jsonl under <conception>/.condash/logs', () => {
    const path = sessionLogPath('/x/conception', 't-abc', new Date('2026-05-13T14:22:07Z'));
    // Date in local time — test passes regardless of TZ because we only
    // check structure, not the exact digits.
    expect(path.startsWith(condashLogsRoot('/x/conception'))).toBe(true);
    expect(path).toMatch(/[/]\d{4}[/]\d{2}[/]\d{2}[/]\d{6}-t-abc\.jsonl$/);
  });
});

describe('resolveLoggingPrefs', () => {
  it('returns defaults when patch is empty', () => {
    const p = resolveLoggingPrefs({});
    expect(p.enabled).toBe(true);
    expect(p.maxFileMb).toBe(50);
    expect(p.maxDirMb).toBe(500);
    expect(p.retentionDays).toBe(14);
    expect(p.ansiPolicy).toBe('raw');
  });

  it('overrides only the specified keys', () => {
    const p = resolveLoggingPrefs({ maxFileMb: 1, ansiPolicy: 'stripped' });
    expect(p.maxFileMb).toBe(1);
    expect(p.ansiPolicy).toBe('stripped');
    expect(p.enabled).toBe(true);
  });
});

describe('stripAnsi', () => {
  it('removes CSI colour codes', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello');
  });

  it('removes OSC title-setting sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123');
  });
});

describe('SessionLogger', () => {
  it('writes spawn / output / exit / close events in order', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-abc',
      side: 'my',
      cwd: '/home/alice',
      spawn: { cmd: '/bin/bash', argv: ['-l'] },
    });
    logger.spawn();
    logger.output('hello\n');
    logger.exit(0);
    await logger.close();

    const path = logger.filePath();
    expect(path).not.toBeNull();
    if (!path) return;
    expect(existsSync(path)).toBe(true);
    const events = readJsonl(path);
    expect(events.map((e) => e.kind)).toEqual(['spawn', 'out', 'exit', 'close']);
    expect(events[0].cmd).toBe('/bin/bash');
    expect(events[1].data).toBe('hello\n');
    expect(events[1].len).toBe(6);
    expect(events[2].exitCode).toBe(0);
  });

  it('files land at <conception>/.condash/logs/YYYY/MM/DD/', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-xyz',
      side: 'code',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    const path = logger.filePath();
    await logger.close();
    expect(path).not.toBeNull();
    if (!path) return;
    expect(path.startsWith(join(tmp, '.condash', 'logs'))).toBe(true);
    expect(path).toMatch(/[/]\d{6}-t-xyz\.jsonl$/);
  });

  it('records input events with `kind: in`', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-i',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    logger.input('ls\r');
    await logger.close();
    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path);
    const inEv = events.find((e) => e.kind === 'in');
    expect(inEv).toBeTruthy();
    expect(inEv?.data).toBe('ls\r');
    expect(inEv?.len).toBe(3);
  });

  it('rotates to a `.2.jsonl` file when the size threshold is hit', async () => {
    const logger = new SessionLogger(
      tmp,
      {
        sid: 't-rot',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      { maxFileMb: 1 / 1024 }, // 1 KB
    );
    logger.spawn();
    // Output 2 KB to force rotation.
    const chunk = 'x'.repeat(256);
    for (let i = 0; i < 8; i++) logger.output(chunk);
    await waitForFlush();
    await logger.close();

    // The original session file's path is whatever the logger wrote on
    // its first event — we read it back via `filePath()` rather than
    // recomputing with `new Date()` at test time, because the rotated
    // continuation must share the original's HHMMSS prefix (spawn time
    // is captured once at construction).
    const original = logger.filePath();
    // After rotation, `filePath()` points at the continuation file.
    // To get the original, derive from the same dirname.
    expect(original).not.toBeNull();
    if (!original) return;
    // Confirm the original-named file (without `.2.`) exists too, with
    // the same HHMMSS prefix as the continuation.
    const baseDir = original.replace(/[/][^/]+$/, '');
    const filesInDir = readdirSync(baseDir).sort();
    // Two `.jsonl` files: one without rotation suffix, one with `.2.jsonl`.
    const jsonlFiles = filesInDir.filter((f) => f.endsWith('.jsonl'));
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(2);
    const continuation = jsonlFiles.find((f) => /\.2\.jsonl$/.test(f));
    const base = jsonlFiles.find((f) => /^\d{6}-t-rot\.jsonl$/.test(f));
    expect(base).toBeTruthy();
    expect(continuation).toBeTruthy();
    // Shared HHMMSS prefix — fixes the rotation-timestamp bug.
    expect(continuation?.slice(0, 6)).toBe(base?.slice(0, 6));

    // The rotation marker lives in the *new* file, recording the source.
    const continuationPath = `${baseDir}/${continuation}`;
    const rotatedEvents = readJsonl(continuationPath);
    const rotateEv = rotatedEvents.find((e) => e.kind === 'rotate');
    expect(rotateEv).toBeTruthy();
    expect(rotateEv?.from).toBe(`${baseDir}/${base}`);
  });

  it('strips ANSI when ansiPolicy is "stripped"', async () => {
    const logger = new SessionLogger(
      tmp,
      {
        sid: 't-a',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      { ansiPolicy: 'stripped' },
    );
    logger.spawn();
    logger.output('\x1b[31mred\x1b[0m');
    await logger.close();
    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path);
    const outEv = events.find((e) => e.kind === 'out');
    expect(outEv?.data).toBe('red');
  });

  it('opens no file and writes nothing when enabled is false', async () => {
    const logger = new SessionLogger(
      tmp,
      {
        sid: 't-off',
        side: 'my',
        cwd: '/x',
        spawn: { cmd: 'bash', argv: [] },
      },
      { enabled: false },
    );
    logger.spawn();
    logger.output('hello');
    logger.exit(0);
    await logger.close();
    expect(logger.filePath()).toBeNull();
  });

  it('coalesces a typed command + Enter into one in record', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-coal-in',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    // Each keystroke arrives separately; Enter (`\r`) closes the record.
    for (const ch of 'echo A') logger.input(ch);
    logger.input('\r');
    await logger.close();
    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path);
    const inEvents = events.filter((e) => e.kind === 'in');
    expect(inEvents).toHaveLength(1);
    expect(inEvents[0].data).toBe('echo A\r');
    expect(inEvents[0].len).toBe(7);
  });

  it('coalesces echoed output bytes until close', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-coal-out',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    // Simulate the pty echoing each typed character.
    for (const ch of 'echo A') logger.output(ch);
    await logger.close();
    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const outEvents = readJsonl(path).filter((e) => e.kind === 'out');
    expect(outEvents).toHaveLength(1);
    expect(outEvents[0].data).toBe('echo A');
  });

  it('keeps in / out coalesce buffers independent; close() flushes both', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-coal-switch',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    // Two keystrokes (no newline yet), then a chunk of output arrives.
    // With independent buffers neither flushes the other — both seal at
    // close(). The `in` lands first because `flushAll()` drains `in`
    // before `out`.
    logger.input('a');
    logger.input('b');
    logger.output('result');
    await logger.close();
    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path);
    const kinds = events.filter((e) => e.kind === 'in' || e.kind === 'out').map((e) => e.kind);
    expect(kinds).toEqual(['in', 'out']);
    const inEv = events.find((e) => e.kind === 'in');
    const outEv = events.find((e) => e.kind === 'out');
    expect(inEv?.data).toBe('ab');
    expect(outEv?.data).toBe('result');
  });

  it('collapses an interactive pty echo burst into one in + one out', async () => {
    // Happy path for the timerless Enter-bounded model. Typing `ls<Enter>`
    // and receiving the listing should produce one IN record (`ls\r`) and
    // one OUT record (echo + listing + any prompt redraw), regardless of
    // how the bytes are interleaved between input() and output() calls.
    const logger = new SessionLogger(tmp, {
      sid: 't-echo',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    for (const ch of 'ls') {
      logger.input(ch);
      logger.output(ch);
    }
    logger.input('\r');
    logger.output('\r\ntotal 0\r\n');
    await logger.close();

    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path);
    const inEvents = events.filter((e) => e.kind === 'in');
    const outEvents = events.filter((e) => e.kind === 'out');
    expect(inEvents).toHaveLength(1);
    expect(inEvents[0].data).toBe('ls\r');
    expect(outEvents).toHaveLength(1);
    expect(outEvents[0].data).toBe('ls\r\ntotal 0\r\n');
  });

  it('does not fragment under delayed keystroke dispatch', async () => {
    // Regression target: v2.21.0–v2.21.3 used idle timers. Under real
    // human typing (~200ms between keys, longer than OUTPUT_IDLE_MS=100ms
    // in v2.21.3), each echoed byte flushed before the next arrived,
    // producing one OUT record per character — the v2.21.3 unit test
    // missed it because it dispatched keystrokes synchronously. The new
    // model has no timers; this test interleaves input/output with a
    // delay larger than any prior idle threshold and asserts the same
    // outcome as the synchronous happy-path test.
    const logger = new SessionLogger(tmp, {
      sid: 't-slow',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    for (const ch of 'ls') {
      logger.input(ch);
      logger.output(ch);
      await new Promise((r) => setTimeout(r, 250));
    }
    logger.input('\r');
    logger.output('\r\ntotal 0\r\n');
    await logger.close();

    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path);
    const inEvents = events.filter((e) => e.kind === 'in');
    const outEvents = events.filter((e) => e.kind === 'out');
    expect(inEvents).toHaveLength(1);
    expect(inEvents[0].data).toBe('ls\r');
    expect(outEvents).toHaveLength(1);
    expect(outEvents[0].data).toBe('ls\r\ntotal 0\r\n');
  });

  it('seals each OUT record at the start of the next IN burst', async () => {
    // Defining behaviour of the transaction-boundary model: the OUT
    // record for cycle N closes when the user starts typing cycle N+1,
    // so each OUT carries echoes + program output + prompt redraw of
    // exactly one command-cycle.
    const logger = new SessionLogger(tmp, {
      sid: 't-cycle',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    // Cycle 1: type 'ls', see echo + listing + new prompt
    for (const ch of 'ls') {
      logger.input(ch);
      logger.output(ch);
    }
    logger.input('\r');
    logger.output('\r\ntotal 0\r\n$ ');
    // Cycle 2: start typing 'pwd' — first keystroke seals cycle 1's OUT
    for (const ch of 'pwd') {
      logger.input(ch);
      logger.output(ch);
    }
    logger.input('\r');
    logger.output('\r\n/home/x\r\n$ ');
    await logger.close();

    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path).filter((e) => e.kind === 'in' || e.kind === 'out');
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: 'in', data: 'ls\r' });
    expect(events[1]).toMatchObject({ kind: 'out', data: 'ls\r\ntotal 0\r\n$ ' });
    expect(events[2]).toMatchObject({ kind: 'in', data: 'pwd\r' });
    expect(events[3]).toMatchObject({ kind: 'out', data: 'pwd\r\n/home/x\r\n$ ' });
  });

  it('caps OUT records at the byte limit for streams without Enter', async () => {
    // Long streams (`tail -f`) and fullscreen TUIs never see a typed
    // newline, so the byte cap is the only thing keeping resident
    // memory bounded. Push >2x the cap through OUT and confirm the
    // buffer flushes in chunks instead of accumulating one record.
    const logger = new SessionLogger(tmp, {
      sid: 't-cap',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    const chunk = 'x'.repeat(8 * 1024); // 8 KB
    const chunks = 20; // 160 KB total — exceeds the 64 KB cap ~2.5x
    for (let i = 0; i < chunks; i++) logger.output(chunk);
    await logger.close();
    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const outEvents = readJsonl(path).filter((e) => e.kind === 'out');
    expect(outEvents.length).toBeGreaterThanOrEqual(2);
    const total = outEvents.reduce((acc, e) => acc + ((e.data as string) ?? '').length, 0);
    expect(total).toBe(chunks * chunk.length);
    for (const ev of outEvents) {
      // Each flushed record fits within the cap plus the chunk-width
      // overrun (we flush after the cap is hit, not pre-emptively).
      expect((ev.data as string).length).toBeLessThanOrEqual(64 * 1024 + chunk.length);
    }
  });

  it('close() is idempotent', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-c',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    await logger.close();
    await logger.close(); // no throw
  });

  it('pause / resume stops writes without closing the file', async () => {
    const logger = new SessionLogger(tmp, {
      sid: 't-pause',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    logger.spawn();
    logger.output('before');
    logger.setPaused(true);
    logger.output('secret');
    logger.setPaused(false);
    logger.output('after');
    await logger.close();
    const path = logger.filePath();
    if (!path) throw new Error('no path');
    const events = readJsonl(path);
    const outEvents = events.filter((e) => e.kind === 'out');
    expect(outEvents.map((e) => e.data)).toEqual(['before', 'after']);
  });

  it('survives mkdir failures by logging to stderr (no throw)', async () => {
    // Point the conception at /dev/null/x — mkdir will refuse.
    const logger = new SessionLogger('/dev/null/x', {
      sid: 't-fail',
      side: 'my',
      cwd: '/x',
      spawn: { cmd: 'bash', argv: [] },
    });
    expect(() => logger.spawn()).not.toThrow();
    await logger.close();
  });
});
