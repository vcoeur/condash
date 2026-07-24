import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The two properties an appended grid body must hold that no output-equality
 * test can see, because both are about what happens when a flush goes WRONG:
 *
 *   1. a fallback must never discard the history that exists only on disk, and
 *   2. the in-place tail rewrite must never leave a reader — or a SIGKILL — with
 *      the old tail stranded behind the new one.
 *
 * Both need the filesystem to misbehave on cue, hence the module mock. It wraps
 * the real `open` so a test can fail a specific call and can watch the order in
 * which a flush issues `truncate` and `write` on the handle.
 */

/** Ops issued on the file handles opened during the flush under test. */
let handleOps: string[] = [];
/** Throw on the Nth matching `open` (1-based). Cleared once it fires. */
let failOpen: { flags: string; nth: number; code: string } | null = null;
/** Throw on the next `write` issued to a handle. Cleared once it fires. */
let failWrite: { code: string } | null = null;
/** Runs immediately after each `truncate`, with the file's bytes as they stand —
 *  the exact intermediate state a concurrent reader would see. */
let afterTruncate: ((snapshot: string) => void) | null = null;

let openCounts: Record<string, number> = {};

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (path: string, flags: string) => {
      openCounts[flags] = (openCounts[flags] ?? 0) + 1;
      if (failOpen && failOpen.flags === flags && openCounts[flags] === failOpen.nth) {
        failOpen = null;
        const err = new Error('injected open failure') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      const handle = await actual.open(path, flags);
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'truncate') {
            return async (len?: number) => {
              handleOps.push('truncate');
              const result = await target.truncate(len);
              if (afterTruncate) {
                const { readFileSync: read } = await import('node:fs');
                afterTruncate(read(path, 'utf8'));
              }
              return result;
            };
          }
          if (prop === 'write') {
            return async (...args: unknown[]) => {
              handleOps.push('write');
              if (failWrite) {
                const code = failWrite.code;
                failWrite = null;
                const err = new Error('injected write failure') as NodeJS.ErrnoException;
                err.code = code;
                throw err;
              }
              return (target.write as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }),
  };
});

import { SessionLogger, type SessionContext } from './terminal-logger';
import { splitContent } from './logs-format';

let tmp: string;
beforeEach(() => {
  handleOps = [];
  openCounts = {};
  failOpen = null;
  failWrite = null;
  afterTruncate = null;
  tmp = mkdtempSync(join(tmpdir(), 'condash-logger-durability-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ctx: SessionContext = {
  sid: 't-dur',
  side: 'my',
  cwd: '/x',
  spawn: { cmd: 'bash', argv: [] },
};

function makeLogger(maxBodyBytes?: number): SessionLogger {
  return new SessionLogger(
    tmp,
    ctx,
    { enabled: true, scrollback: 40, markerIntervalSec: 0 },
    100_000,
    () => new Date(),
    maxBodyBytes,
  );
}

/** Feed `count` uniquely-numbered lines and flush. `pad` widens each row so a
 *  test can reach a byte cap without needing thousands of flushes. */
async function emit(logger: SessionLogger, from: number, count: number, pad = 0): Promise<void> {
  let chunk = '';
  for (let i = 0; i < count; i++) chunk += `line-${from + i}${'.'.repeat(pad)}\r\n`;
  logger.output(chunk);
  await logger.flushForTests();
}

function bodyOf(logger: SessionLogger): string {
  return splitContent(readFileSync(logger.filePath()!, 'utf8')).text;
}

describe('grid tail rewrite ordering (F2)', () => {
  it('writes before truncating while the tail grows, so no reader sees a mixed file', async () => {
    const logger = makeLogger();
    logger.spawn();
    await logger.flushForTests();
    await emit(logger, 0, 5);
    handleOps = [];
    await emit(logger, 5, 20); // more rows → a longer tail
    expect(handleOps.filter((op) => op === 'write' || op === 'truncate')).toEqual([
      'write',
      'truncate',
    ]);
    await logger.close();
  });

  it('truncates before writing when the tail shrinks, leaving a valid prefix in the window', async () => {
    // Writing first would strand the old tail's surplus bytes past the new one:
    // a screenful duplicated after the new one, and on a SIGKILL in that window
    // permanent — with the footer no longer the last line. Truncating first
    // leaves a PREFIX of the file, which every reader already tolerates.
    const logger = makeLogger();
    logger.spawn();
    await logger.flushForTests();
    logger.output('filler line that makes the viewport tall\r\n'.repeat(30));
    await logger.flushForTests();
    const before = readFileSync(logger.filePath()!, 'utf8');

    handleOps = [];
    let windowSnapshot: string | null = null;
    afterTruncate = (snapshot) => {
      windowSnapshot ??= snapshot;
    };
    // Clear the screen: the live tail collapses to almost nothing.
    logger.output('\x1b[2J\x1b[1;1Hsmall\r\n');
    await logger.flushForTests();
    afterTruncate = null;

    expect(handleOps.filter((op) => op === 'write' || op === 'truncate')).toEqual([
      'truncate',
      'write',
    ]);
    // The state a concurrent reader could observe is a prefix of what was there
    // — never the new tail with the old one stranded behind it.
    expect(windowSnapshot).not.toBeNull();
    expect(before.startsWith(windowSnapshot!)).toBe(true);
    expect(windowSnapshot!).toContain('# condash:');

    const after = readFileSync(logger.filePath()!, 'utf8');
    expect(after).toContain('small');
    // No stale duplicate of the pre-clear screen survives past the new tail.
    expect((after.match(/filler line/g) ?? []).length).toBeLessThan(
      (before.match(/filler line/g) ?? []).length + 1,
    );
    await logger.close();
  });
});

describe('grid fallbacks preserve the on-disk history (F1)', () => {
  it('leaves the file untouched when the tail write faults, and heals on the retry', async () => {
    const logger = makeLogger();
    logger.spawn();
    await logger.flushForTests();
    await emit(logger, 0, 60); // more than the 40-row scrollback → real history
    const historic = readFileSync(logger.filePath()!, 'utf8');
    expect(historic).toContain('line-0');

    failWrite = { code: 'EIO' };
    await emit(logger, 60, 5);
    // The flush declined to write rather than composing a wipe from the buffer.
    expect(readFileSync(logger.filePath()!, 'utf8')).toBe(historic);

    // The retry rebuilds around the history it reads back off disk.
    await emit(logger, 65, 5);
    const body = bodyOf(logger);
    expect(body).toContain('line-0');
    expect(body).toContain('line-69');
    await logger.close();
  });

  it('does not wipe the history when the trim read faults at the cap boundary', async () => {
    // The sharpest case in the review: `readGridHistory` returning '' on an
    // exception turns an intended 50 % trim into a 100 % wipe, reported only to
    // stderr and leaving a well-formed-looking log behind.
    const logger = makeLogger(2048);
    logger.spawn();
    await logger.flushForTests();
    for (let burst = 0; burst < 20; burst++) await emit(logger, burst * 20, 20, 40);
    const beforeTrim = readFileSync(logger.filePath()!, 'utf8');
    expect(beforeTrim.length).toBeGreaterThan(2048);

    openCounts = {};
    failOpen = { flags: 'r', nth: 1, code: 'EIO' }; // the trim's own read
    await emit(logger, 1000, 10, 40);
    // Untouched — not truncated to the live buffer.
    expect(readFileSync(logger.filePath()!, 'utf8')).toBe(beforeTrim);

    // And the next flush trims for real, keeping the newest half rather than none.
    await emit(logger, 2000, 10, 40);
    const body = bodyOf(logger);
    expect(body).toContain('line-2009');
    expect(body.length).toBeGreaterThan(1024);
    await logger.close();
  });

  it('rebuilds around the surviving history when the integrity guard misses', async () => {
    const logger = makeLogger();
    logger.spawn();
    await logger.flushForTests();
    await emit(logger, 0, 60);
    expect(bodyOf(logger)).toContain('line-0');

    // Something changed the file under us: the length + tail watermark no longer
    // matches, so the append path hands over to the rewrite.
    appendFileSync(logger.filePath()!, 'external junk\n');
    await emit(logger, 60, 5);

    const body = bodyOf(logger);
    // The history that was on disk is still on disk — the rewrite read it back
    // instead of composing over it from the live buffer.
    expect(body).toContain('line-0');
    expect(body).toContain('line-64');
    await logger.close();
  });
});
