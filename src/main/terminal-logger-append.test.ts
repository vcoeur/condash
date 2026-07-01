import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Record the flag every fs `open()` uses so a test can tell an append ('a')
// from a full rewrite ('w'). Delegates to the real implementation. Module-level
// mock — isolated to this file so the main terminal-logger tests are untouched.
const openFlags: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn((path: string, flags: string) => {
      openFlags.push(flags);
      return actual.open(path, flags);
    }),
  };
});

import { SessionLogger, type SessionContext } from './terminal-logger';

const PREFIX = '\x1b]7373;agent-transcript;';
const BEL = '\x07';
/** One single-packet `msg` OSC frame, as a cooperating harness emits it. */
function msgPacket(id: string, text: string): string {
  const b64 = Buffer.from(
    JSON.stringify({ v: 1, t: 'msg', role: 'assistant', text }),
    'utf8',
  ).toString('base64');
  return `${PREFIX}${id};0;1;${b64}${BEL}`;
}

let tmp: string;
beforeEach(() => {
  openFlags.length = 0;
  tmp = mkdtempSync(join(tmpdir(), 'condash-logger-append-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ctx: SessionContext = {
  sid: 't-app',
  side: 'my',
  cwd: '/x',
  spawn: { cmd: 'bash', argv: [] },
};

describe('SessionLogger append-only flush (G9)', () => {
  it('appends transcript growth instead of rewriting the whole file each flush', async () => {
    const logger = new SessionLogger(tmp, ctx, { enabled: true }, 50);
    logger.spawn();
    const count = 5;
    for (let k = 0; k < count; k++) {
      logger.output(msgPacket(`m${k}`, `message ${k}`));
      await logger.flushForTests();
    }
    const appendOpens = openFlags.filter((f) => f === 'a').length;
    const writeOpens = openFlags.filter((f) => f === 'w').length;
    // Once the transcript is established, every growth flush appends only the
    // delta — the G9 fix. The only full rewrites here are the spawn write and
    // the single grid→transcript header flip on the first message.
    expect(appendOpens).toBeGreaterThanOrEqual(count - 1);
    expect(writeOpens).toBeLessThanOrEqual(2);

    await logger.close();
    // Content is complete + correct despite the appends.
    const raw = readFileSync(logger.filePath()!, 'utf8');
    for (let k = 0; k < count; k++) expect(raw).toContain(`[assistant] message ${k}`);
  });

  it('falls back to a full rewrite when the byte cap trims (content stays correct)', async () => {
    // A trim shrinks render(), so the new text is not a prefix-extension of the
    // last-written text → full rewrite. Verify content correctness across that.
    const logger = new SessionLogger(tmp, ctx, { enabled: true }, 50);
    logger.spawn();
    const big = 'z'.repeat(2_000_000); // ~2 MB messages; a few exceed the 8 MB cap
    for (let k = 0; k < 6; k++) {
      logger.output(msgPacket(`t${k}`, `${k}:${big}`));
      await logger.flushForTests();
    }
    await logger.close();
    const raw = readFileSync(logger.filePath()!, 'utf8');
    // Newest survived; the oldest were trimmed out of the on-disk body too.
    expect(raw).toContain('[assistant] 5:');
    expect(raw).not.toContain('[assistant] 0:');
  });
});
