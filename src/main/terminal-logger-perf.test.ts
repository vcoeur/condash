/**
 * Cover for the flush's perf span (C1).
 *
 * `gridRenderMs` brackets `GridBodyRenderer.render()` and stops there, but the
 * compose join, the write, and the bookkeeping's second UTF-8 encode are all
 * O(retained size) and sat outside every span — so the recorded per-flush cost
 * was an understatement of unknown size, and the parts an append-only body would
 * remove could not be measured at all. These tests lock the span onto the whole
 * flush and the sub-spans inside it, for both bodies (grid and transcript), plus
 * the "costs nothing while recording is off" property that lets the logger call
 * into the recorder unconditionally.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { perfLog, type SessionRecord } from './perf-log';
import { SessionLogger, type SessionContext } from './terminal-logger';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-logger-perf-'));
});

afterEach(() => {
  perfLog.setEnabled(false);
  rmSync(tmp, { recursive: true, force: true });
});

const ctx: SessionContext = {
  sid: 't-perf',
  side: 'my',
  cwd: '/home/alice',
  spawn: { cmd: '/bin/bash', argv: ['-l'] },
};

/** A logger writing into the test's temp conception, capture on. */
function makeLogger(): SessionLogger {
  return new SessionLogger(tmp, ctx, { enabled: true });
}

/** The recorded session slice for `t-perf`, after taking the window. */
function sessionRecord(): SessionRecord | undefined {
  return perfLog.takeRecord()?.sessions['t-perf'];
}

/** One single-packet `msg` OSC frame, as a cooperating harness emits it —
 *  the input that puts the logger on the transcript body instead of the grid. */
function msgPacket(id: string, role: string, text: string): string {
  const b64 = Buffer.from(JSON.stringify({ v: 1, t: 'msg', role, text }), 'utf8').toString(
    'base64',
  );
  return `\x1b]7373;agent-transcript;${id};0;1;${b64}\x07`;
}

describe('flush instrumentation', () => {
  it('times the whole grid flush, not only the render', async () => {
    perfLog.setEnabled(true, tmp);
    const logger = makeLogger();
    logger.output('hello world\r\n'.repeat(200));
    await logger.flushForTests();

    const session = sessionRecord();
    expect(session?.flushes).toBe(1);
    // The render is inside the flush, so the flush total can never be smaller.
    expect(session?.flushMs).toBeGreaterThanOrEqual(session?.gridRenderMs ?? 0);
    // Compose + write + the bookkeeping encode were previously unmeasured. They
    // are the point of this change, so each must be present and inside the
    // total.
    expect(session?.composeMs).toBeGreaterThan(0);
    expect(session?.writeMs).toBeGreaterThan(0);
    expect(session?.encodeMs).toBeGreaterThan(0);
    const parts =
      (session?.gridRenderMs ?? 0) +
      (session?.composeMs ?? 0) +
      (session?.encodeMs ?? 0) +
      (session?.writeMs ?? 0);
    expect(parts).toBeLessThanOrEqual((session?.flushMs ?? 0) + 0.001);

    await logger.close();
  });

  it('keeps every sub-span meaningful once the grid body is appending', async () => {
    // The steady-state grid path composes only a suffix, encodes only that, and
    // writes it in place — no whole-file compose, no rename. The spans have to
    // follow it there: were they to go ABSENT (not zero) on the path a real
    // session spends all its time on, the attribution formula would dump the
    // entire append write into the unattributed remainder and the instrument
    // would report the optimisation as a blind spot.
    perfLog.setEnabled(true, tmp);
    const logger = makeLogger();
    logger.spawn();
    await logger.flushForTests(); // the full rewrite that establishes the file
    perfLog.takeRecord(); // drop that window; measure only the append below
    logger.output('hello world\r\n'.repeat(200));
    await logger.flushForTests();

    const session = sessionRecord();
    expect(session?.flushes).toBe(1);
    expect(session?.gridRenderMs).toBeGreaterThan(0);
    expect(session?.composeMs).toBeGreaterThan(0);
    expect(session?.encodeMs).toBeGreaterThan(0);
    expect(session?.writeMs).toBeGreaterThan(0);
    const parts =
      (session?.gridRenderMs ?? 0) +
      (session?.composeMs ?? 0) +
      (session?.encodeMs ?? 0) +
      (session?.writeMs ?? 0);
    expect(parts).toBeLessThanOrEqual((session?.flushMs ?? 0) + 0.001);

    await logger.close();
  });

  it('times a transcript flush too, where there is no grid render at all', async () => {
    // A cooperating agent tab never reaches GridBodyRenderer, so `gridRenderMs`
    // reports nothing for it — and before this change its flush cost was
    // invisible in full.
    perfLog.setEnabled(true, tmp);
    const logger = makeLogger();
    logger.output(msgPacket('f1', 'user', 'hi'));
    await logger.flushForTests();

    const session = sessionRecord();
    expect(session?.gridRenderMs).toBeUndefined();
    expect(session?.flushes).toBe(1);
    expect(session?.flushMs).toBeGreaterThan(0);
    expect(session?.writeMs).toBeGreaterThan(0);

    await logger.close();
  });

  it('counts one flush per flush that had work to do', async () => {
    // A flush with nothing new short-circuits on the `dirty` gate before any
    // work — that is not a flush cost and must not enter the denominator of a
    // "ms per flush" reading.
    perfLog.setEnabled(true, tmp);
    const logger = makeLogger();
    logger.output('one line\r\n');
    await logger.flushForTests();
    await logger.flushForTests(); // nothing new — no work, no count
    logger.output('another line\r\n');
    await logger.flushForTests();

    expect(sessionRecord()?.flushes).toBe(2);

    await logger.close();
  });

  it('records nothing while recording is off', async () => {
    const logger = makeLogger();
    logger.output('quiet\r\n');
    await logger.flushForTests();

    // Enabling only now: the window opened after the flush, so a leaked counter
    // from it would show up here.
    perfLog.setEnabled(true, tmp);
    expect(sessionRecord()).toBeUndefined();

    await logger.close();
  });
});
