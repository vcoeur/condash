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
import { OscTranscriptExtractor } from './osc-transcript';

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

  it('incremental appends build a byte-identical file to a full compose (multi-byte)', async () => {
    // The core write-amplification fix: prove the incrementally-appended file is
    // byte-for-byte what a from-scratch full compose of the same content would
    // be. Multi-byte text (accents / emoji) also guards the byte-length + tail
    // watermark: a char-vs-byte offset bug would fail the tail check and fall
    // back to full rewrites (no 'a' opens) — which the append assertion catches.
    const logger = new SessionLogger(tmp, ctx, { enabled: true, markerIntervalSec: 0 }, 50);
    logger.spawn();
    const reference = new OscTranscriptExtractor();
    const count = 8;
    for (let k = 0; k < count; k++) {
      const text = `message ${k} — café ☕ ${'z'.repeat(k * 3)}`;
      logger.output(msgPacket(`m${k}`, text));
      reference.feed(msgPacket(`m${k}`, text));
      await logger.flushForTests();
    }
    // Read the in-flight file (no footer yet) built purely by header write +
    // incremental appends.
    const raw = readFileSync(logger.filePath()!, 'utf8');
    const headerLine = raw.slice(0, raw.indexOf('\n'));
    const expected = `${headerLine}\n\n${reference.render()}\n`;
    expect(raw).toBe(expected);
    // And it really took the incremental path (not silently full-rewriting).
    expect(openFlags.filter((f) => f === 'a').length).toBeGreaterThanOrEqual(count - 2);

    await logger.close();
  });

  it('produces an identical file whether the OSC is scanned by the logger or pre-scanned', async () => {
    // Fix T4: terminals.ts scans once and hands the logger `{clean, frames}`; a
    // standalone caller lets the logger scan `data` itself. Both must yield the
    // same on-disk file.
    const shared = new OscTranscriptExtractor();
    const scanned = new SessionLogger(tmp, { ...ctx, sid: 't-scan' }, { enabled: true }, 50);
    const pre = new SessionLogger(tmp, { ...ctx, sid: 't-pre' }, { enabled: true }, 50);
    scanned.spawn();
    pre.spawn();
    const chunks = [
      'boot line\r\n',
      msgPacket('a', 'user question'),
      'noise\r\n',
      msgPacket('b', 'assistant answer'),
    ];
    for (const chunk of chunks) {
      scanned.output(chunk); // logger scans it itself
      const { clean, frames } = shared.feedCapturingFrames(chunk);
      pre.output(chunk, { clean, frames }); // pre-scanned by the shared extractor
      await scanned.flushForTests();
      await pre.flushForTests();
    }
    await scanned.close();
    await pre.close();
    const scannedBody = readFileSync(scanned.filePath()!, 'utf8').split('\n').slice(1).join('\n');
    const preBody = readFileSync(pre.filePath()!, 'utf8').split('\n').slice(1).join('\n');
    // Drop the header line (differs only by sid) and compare body + footer.
    expect(preBody).toBe(scannedBody);
  });

  it('falls back to a full rewrite when the byte cap trims (content stays correct)', async () => {
    // A trim shrinks render(), so the new text is not a prefix-extension of the
    // last-written text → full rewrite. Verify content correctness across that.
    const logger = new SessionLogger(tmp, ctx, { enabled: true, markerIntervalSec: 0 }, 50);
    logger.spawn();
    const big = 'z'.repeat(2_000_000); // ~2 MB messages; a few exceed the 8 MB cap
    for (let k = 0; k < 6; k++) {
      logger.output(msgPacket(`t${k}`, `${k}:${big}`));
      await logger.flushForTests();
    }
    // A cap trim is not a prefix-extension, so the incremental watermark goes
    // stale and the flush falls back to a full rewrite ('w') — after at least
    // one earlier append ('a') on the pre-trim growth.
    expect(openFlags.filter((f) => f === 'a').length).toBeGreaterThanOrEqual(1);
    expect(openFlags.filter((f) => f === 'w').length).toBeGreaterThanOrEqual(2);

    await logger.close();
    const raw = readFileSync(logger.filePath()!, 'utf8');
    // Newest survived; the oldest were trimmed out of the on-disk body too.
    expect(raw).toContain('[assistant] 5:');
    expect(raw).not.toContain('[assistant] 0:');
  });
});
