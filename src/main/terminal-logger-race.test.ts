import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hook invoked synchronously inside the mocked rename() — the exact window
// between a full-rewrite flush's body render/write and recordWrite()'s
// bookkeeping snapshot. Lets a test simulate a pty output() chunk racing an
// in-flight flush (L1). Module-level mock, isolated to this file.
let renameHook: (() => void) | null = null;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (renameHook) {
        const hook = renameHook;
        renameHook = null;
        hook();
      }
      return actual.rename(from, to);
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
  renameHook = null;
  tmp = mkdtempSync(join(tmpdir(), 'condash-logger-race-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ctx: SessionContext = {
  sid: 't-race',
  side: 'my',
  cwd: '/x',
  spawn: { cmd: 'bash', argv: [] },
};

describe('SessionLogger — output racing an in-flight full-rewrite flush (L1)', () => {
  it('does not drop a transcript line appended during the flush write window', async () => {
    // 100s debounce so only the explicit flushForTests() calls fire.
    const logger = new SessionLogger(tmp, ctx, { enabled: true, markerIntervalSec: 0 }, 100_000);
    logger.spawn();
    await logger.flushForTests(); // drain spawn's (empty grid) write

    // First message → a full rewrite (grid→transcript header flip). A second
    // message arrives *during* that rewrite's rename window, i.e. after the body
    // was rendered + written but before recordWrite snapshots the cursor.
    logger.output(msgPacket('m0', 'first'));
    renameHook = () => logger.output(msgPacket('mr', 'raced during write'));
    await logger.flushForTests();

    // The next incremental flush must append the raced line. Pre-fix, recordWrite
    // read the extractor's *current* cursor (already advanced past the raced
    // line), so appendedSince() returned nothing and the line was lost until a
    // later full rewrite. Assert on the in-flight file (no footer yet) so a
    // close-time full rewrite can't mask the hole.
    await logger.flushForTests();
    const raw = readFileSync(logger.filePath()!, 'utf8');
    expect(raw).toContain('[assistant] first');
    expect(raw).toContain('[assistant] raced during write');

    await logger.close();
  });

  it('does not skip the grid render for bytes that raced the write window', async () => {
    // Grid variant: plain (non-OSC) output renders through the headless xterm.
    // A byte racing the write window must not fold into lastGridBytes, or the
    // next flush wrongly takes the render-skip and the raced text never lands.
    const logger = new SessionLogger(tmp, ctx, { enabled: true, markerIntervalSec: 0 }, 100_000);
    logger.spawn();
    await logger.flushForTests();

    logger.output('line one\r\n');
    renameHook = () => logger.output('raced line\r\n');
    await logger.flushForTests();

    await logger.flushForTests();
    const raw = readFileSync(logger.filePath()!, 'utf8');
    expect(raw).toContain('line one');
    expect(raw).toContain('raced line');

    await logger.close();
  });
});
