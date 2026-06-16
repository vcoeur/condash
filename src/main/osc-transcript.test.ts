import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  MAX_OSC_BUFFER_CHARS,
  MAX_PENDING_FRAMES,
  MAX_TRANSCRIPT_LINES,
  OscTranscriptExtractor,
} from './osc-transcript';

const BEL = '\x07';
const PREFIX = '\x1b]7373;agent-transcript;';

/** Build the OSC packets for one frame, splitting the base64 into `pieces`. */
function packets(id: string, frame: unknown, pieces = 1): string {
  const b64 = Buffer.from(JSON.stringify(frame), 'utf8').toString('base64');
  const size = Math.ceil(b64.length / pieces);
  const n = Math.ceil(b64.length / size) || 1;
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `${PREFIX}${id};${i};${n};${b64.slice(i * size, (i + 1) * size)}${BEL}`;
  }
  return out;
}

describe('OscTranscriptExtractor', () => {
  it('passes ordinary terminal output through untouched', () => {
    const ex = new OscTranscriptExtractor();
    const data = 'hello \x1b[31mworld\x1b[0m\r\n$ ';
    expect(ex.feed(data)).toBe(data);
    expect(ex.hasTranscript()).toBe(false);
  });

  it('extracts a single-packet message frame and strips it from the stream', () => {
    const ex = new OscTranscriptExtractor();
    const pkt = packets('0', {
      v: 1,
      t: 'msg',
      sid: 's',
      mid: 'm',
      role: 'user',
      text: 'hi there',
    });
    const clean = ex.feed(`before${pkt}after`);
    expect(clean).toBe('beforeafter');
    expect(ex.hasTranscript()).toBe(true);
    expect(ex.render()).toBe('[user] hi there');
  });

  it('reassembles a frame split across multiple pieces', () => {
    const ex = new OscTranscriptExtractor();
    const long = 'x'.repeat(5000);
    const pkt = packets('1', { v: 1, t: 'msg', role: 'assistant', text: long }, 6);
    expect(pkt.split(PREFIX).length - 1).toBeGreaterThan(1); // really chunked
    ex.feed(pkt);
    expect(ex.render()).toBe(`[assistant] ${long}`);
  });

  it('reassembles a frame whose packets arrive across feed boundaries', () => {
    const ex = new OscTranscriptExtractor();
    const pkt = packets('2', { v: 1, t: 'msg', role: 'assistant', text: 'split me' });
    const mid = Math.floor(pkt.length / 2);
    let clean = ex.feed('a' + pkt.slice(0, mid));
    clean += ex.feed(pkt.slice(mid) + 'b');
    expect(clean).toBe('ab');
    expect(ex.render()).toBe('[assistant] split me');
  });

  it('orders multiple messages and joins them', () => {
    // Pin the clock: with the real-time default, a run that straddles a
    // wall-clock minute boundary splices a `<!-- minute -->` marker between the
    // messages and breaks this exact-render assertion (the flake that reddened
    // CI was the line-cap test below).
    const ex = new OscTranscriptExtractor(() => new Date(2026, 4, 30, 20, 15, 0));
    ex.feed(packets('0', { v: 1, t: 'msg', role: 'user', text: 'q' }));
    ex.feed(packets('1', { v: 1, t: 'msg', role: 'assistant', text: 'a' }));
    ex.feed(packets('2', { v: 1, t: 'end', sid: 's' }));
    expect(ex.render()).toBe('[user] q\n\n[assistant] a');
  });

  it('labels reasoning frames distinctly from the assistant response', () => {
    // Pinned clock — same minute-boundary flake guard as above.
    const ex = new OscTranscriptExtractor(() => new Date(2026, 4, 30, 20, 15, 0));
    ex.feed(packets('0', { v: 1, t: 'msg', role: 'user', text: 'why?' }));
    ex.feed(packets('1', { v: 1, t: 'msg', role: 'reasoning', text: 'thinking…' }));
    ex.feed(packets('2', { v: 1, t: 'msg', role: 'assistant', text: 'because' }));
    expect(ex.render()).toBe('[user] why?\n\n[reasoning] thinking…\n\n[assistant] because');
  });

  it('ignores malformed packets without breaking', () => {
    const ex = new OscTranscriptExtractor();
    const clean = ex.feed(`${PREFIX}bad;packet${BEL}tail`);
    expect(clean).toBe('tail');
    expect(ex.hasTranscript()).toBe(false);
  });

  it('bails out of an unterminated OSC past the byte cap and re-emits the buffer', () => {
    const ex = new OscTranscriptExtractor();
    // A prefix with no terminator: held back at first…
    expect(ex.feed(`${PREFIX}0;0;1;`)).toBe('');
    // …but once the accumulated sequence exceeds the cap, the buffered bytes
    // come back out so the grid render isn't silenced for the session.
    const flood = 'A'.repeat(MAX_OSC_BUFFER_CHARS + 1024);
    const reEmitted = ex.feed(flood);
    expect(reEmitted.startsWith(PREFIX)).toBe(true);
    expect(reEmitted.length).toBe(PREFIX.length + '0;0;1;'.length + flood.length);
    expect(ex.hasTranscript()).toBe(false);
    // The extractor has fully recovered: ordinary output passes through and
    // a well-formed packet still captures.
    expect(ex.feed('normal output')).toBe('normal output');
    ex.feed(packets('1', { v: 1, t: 'msg', role: 'user', text: 'after bailout' }));
    expect(ex.render()).toBe('[user] after bailout');
  });

  it('holds an unterminated OSC below the cap (no premature re-emit)', () => {
    const ex = new OscTranscriptExtractor();
    expect(ex.feed(`${PREFIX}0;0;1;${'B'.repeat(1024)}`)).toBe('');
    // Terminator arrives later — the packet is consumed, nothing leaks out.
    expect(ex.feed(BEL)).toBe('');
  });

  it('caps pending incomplete frames, evicting the oldest', () => {
    const ex = new OscTranscriptExtractor();
    const frame = { v: 1, t: 'msg', role: 'user', text: 'late frame' };
    const b64 = Buffer.from(JSON.stringify(frame), 'utf8').toString('base64');
    const half = Math.ceil(b64.length / 2);
    // First piece of frame 'late', then a flood of other pending frames.
    ex.feed(`${PREFIX}late;0;2;${b64.slice(0, half)}${BEL}`);
    for (let k = 0; k < MAX_PENDING_FRAMES + 8; k++) {
      ex.feed(`${PREFIX}flood-${k};0;2;AAAA${BEL}`);
    }
    // The evicted frame can no longer be assembled by its second piece.
    ex.feed(`${PREFIX}late;1;2;${b64.slice(half)}${BEL}`);
    expect(ex.hasTranscript()).toBe(false);
  });

  it('caps the transcript line count, dropping the oldest lines', () => {
    // Pin the clock. With the real-time default, when this ~20k-message loop
    // happens to straddle a wall-clock minute boundary, one `<!-- minute -->`
    // marker is spliced in, occupies a slot in the capped list, and shifts the
    // oldest retained message by one — `lines[0]` becomes `msg 51`, not `msg
    // 50`. That is the intermittent failure that reddened main CI (a run that
    // landed at exactly HH:35:00). A constant clock emits no markers, so the
    // cap maths is exact and deterministic.
    const ex = new OscTranscriptExtractor(() => new Date(2026, 4, 30, 20, 15, 0));
    const overshoot = 50;
    for (let k = 0; k < MAX_TRANSCRIPT_LINES + overshoot; k++) {
      ex.feed(packets(`m${k}`, { v: 1, t: 'msg', role: 'assistant', text: `msg ${k}` }));
    }
    const lines = ex.render().split('\n\n');
    expect(lines.length).toBe(MAX_TRANSCRIPT_LINES);
    expect(lines[0]).toBe(`[assistant] msg ${overshoot}`);
    expect(lines[lines.length - 1]).toBe(`[assistant] msg ${MAX_TRANSCRIPT_LINES + overshoot - 1}`);
  });

  it('display-safety: the OSC is not rendered by xterm', async () => {
    // condash's headless logger and the live renderer both parse the stream
    // through @xterm/headless; an unknown OSC must be swallowed, never shown.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const pkt = packets('0', { v: 1, t: 'msg', role: 'assistant', text: 'SECRET_PAYLOAD' });
    await new Promise<void>((resolve) => term.write(`visible${pkt}`, () => resolve()));
    let rendered = '';
    for (let y = 0; y < term.buffer.active.length; y++) {
      rendered += term.buffer.active.getLine(y)?.translateToString(true) ?? '';
    }
    expect(rendered).toContain('visible');
    expect(rendered).not.toContain('SECRET_PAYLOAD');
    expect(rendered).not.toContain('agent-transcript');
    term.dispose();
  });
});

describe('OscTranscriptExtractor timestamp markers', () => {
  /** Feed one complete `msg` frame with a unique frameId. */
  function feedMsg(ex: OscTranscriptExtractor, role: string, text: string, id: string): void {
    ex.feed(packets(id, { v: 1, t: 'msg', role, text }));
  }

  it('emits no marker for messages within the same minute', () => {
    const clock = new Date(2026, 4, 30, 20, 15, 0);
    const ex = new OscTranscriptExtractor(() => clock);
    feedMsg(ex, 'user', 'hi', 'a');
    feedMsg(ex, 'assistant', 'hey', 'b');
    expect(ex.render()).toBe('[user] hi\n\n[assistant] hey');
  });

  it('never emits a marker before the first message', () => {
    const ex = new OscTranscriptExtractor(() => new Date(2026, 4, 30, 9, 5, 0));
    feedMsg(ex, 'user', 'only', 'a');
    expect(ex.render()).toBe('[user] only');
  });

  it('inserts a marker when the minute rolls over', () => {
    let clock = new Date(2026, 4, 30, 20, 15, 30);
    const ex = new OscTranscriptExtractor(() => clock);
    feedMsg(ex, 'user', 'first', 'a');
    clock = new Date(2026, 4, 30, 20, 16, 5);
    feedMsg(ex, 'assistant', 'second', 'b');
    expect(ex.render()).toBe('[user] first\n\n<!-- 2026-05-30:20:16 -->\n\n[assistant] second');
  });

  it('emits exactly one marker per minute even with several messages', () => {
    let clock = new Date(2026, 4, 30, 20, 15, 0);
    const ex = new OscTranscriptExtractor(() => clock);
    feedMsg(ex, 'user', 'm1', 'a');
    clock = new Date(2026, 4, 30, 20, 16, 0);
    feedMsg(ex, 'assistant', 'm2', 'b');
    feedMsg(ex, 'user', 'm3', 'c');
    expect(ex.render()).toBe(
      '[user] m1\n\n<!-- 2026-05-30:20:16 -->\n\n[assistant] m2\n\n[user] m3',
    );
  });

  it('emits a marker for each successive minute rollover', () => {
    let clock = new Date(2026, 11, 1, 0, 0, 0);
    const ex = new OscTranscriptExtractor(() => clock);
    feedMsg(ex, 'user', 'a', '1');
    clock = new Date(2026, 11, 1, 0, 1, 0);
    feedMsg(ex, 'assistant', 'b', '2');
    clock = new Date(2026, 11, 1, 0, 2, 0);
    feedMsg(ex, 'assistant', 'c', '3');
    expect(ex.render()).toBe(
      '[user] a\n\n<!-- 2026-12-01:00:01 -->\n\n[assistant] b\n\n<!-- 2026-12-01:00:02 -->\n\n[assistant] c',
    );
  });

  it('zero-pads month, day, hour, and minute', () => {
    let clock = new Date(2026, 0, 3, 4, 5, 0);
    const ex = new OscTranscriptExtractor(() => clock);
    feedMsg(ex, 'user', 'x', 'a');
    clock = new Date(2026, 0, 3, 4, 6, 0);
    feedMsg(ex, 'assistant', 'y', 'b');
    expect(ex.render()).toContain('<!-- 2026-01-03:04:06 -->');
  });
});
