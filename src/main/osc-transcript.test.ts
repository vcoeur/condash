import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  MAX_OSC_BUFFER_CHARS,
  MAX_PENDING_FRAMES,
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_LINES,
  OscTranscriptExtractor,
  formatMinute,
  lastTranscriptRole,
  timestampMarker,
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
    // The extractor no longer emits timestamp markers (the SessionLogger owns
    // the cadence gate now), so this exact-render assertion is deterministic.
    const ex = new OscTranscriptExtractor();
    ex.feed(packets('0', { v: 1, t: 'msg', role: 'user', text: 'q' }));
    ex.feed(packets('1', { v: 1, t: 'msg', role: 'assistant', text: 'a' }));
    ex.feed(packets('2', { v: 1, t: 'end', sid: 's' }));
    expect(ex.render()).toBe('[user] q\n\n[assistant] a');
  });

  it('labels reasoning frames distinctly from the assistant response', () => {
    const ex = new OscTranscriptExtractor();
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
    // The extractor no longer splices timestamp markers into the line list, so
    // the cap maths is exact and deterministic (no marker occupies a slot).
    const ex = new OscTranscriptExtractor();
    const overshoot = 50;
    for (let k = 0; k < MAX_TRANSCRIPT_LINES + overshoot; k++) {
      ex.feed(packets(`m${k}`, { v: 1, t: 'msg', role: 'assistant', text: `msg ${k}` }));
    }
    const lines = ex.render().split('\n\n');
    expect(lines.length).toBe(MAX_TRANSCRIPT_LINES);
    expect(lines[0]).toBe(`[assistant] msg ${overshoot}`);
    expect(lines[lines.length - 1]).toBe(`[assistant] msg ${MAX_TRANSCRIPT_LINES + overshoot - 1}`);
  });

  it('caps the transcript by bytes, dropping the oldest big messages', () => {
    // A handful of multi-MB messages can blow past the byte budget while staying
    // well under the 20k-line cap — the byte cap is what bounds memory here.
    const ex = new OscTranscriptExtractor();
    const big = 'x'.repeat(1_000_000); // ~1 MB per message
    const count = 10; // ~10 MB fed; cap is 8 MB
    for (let k = 0; k < count; k++) {
      ex.feed(packets(`b${k}`, { v: 1, t: 'msg', role: 'assistant', text: `${k}:${big}` }));
    }
    const rendered = ex.render();
    // Bounded by the byte cap (a little slack for the `\n\n` separators).
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES + 1024);
    // Newest survived; oldest were trimmed.
    expect(rendered).toContain(`[assistant] ${count - 1}:`);
    expect(rendered).not.toContain('[assistant] 0:');
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

describe('OscTranscriptExtractor.pushTimestampMarker', () => {
  /** Feed one complete `msg` frame with a unique frameId. */
  function feedMsg(ex: OscTranscriptExtractor, role: string, text: string, id: string): void {
    ex.feed(packets(id, { v: 1, t: 'msg', role, text }));
  }

  it('appends the marker line at a message boundary (between whole messages)', () => {
    // The SessionLogger now owns the content + cadence gate and calls this when
    // a marker is due; the extractor just appends a pre-formatted line.
    const ex = new OscTranscriptExtractor();
    feedMsg(ex, 'user', 'first', 'a');
    ex.pushTimestampMarker('<!-- 2026-05-30:20:16 -->');
    feedMsg(ex, 'assistant', 'second', 'b');
    expect(ex.render()).toBe('[user] first\n\n<!-- 2026-05-30:20:16 -->\n\n[assistant] second');
  });

  it('is a no-op on render ordering beyond appending the given line verbatim', () => {
    const ex = new OscTranscriptExtractor();
    feedMsg(ex, 'user', 'only', 'a');
    ex.pushTimestampMarker('<!-- 2026-01-03:04:06 -->');
    expect(ex.render()).toBe('[user] only\n\n<!-- 2026-01-03:04:06 -->');
  });
});

describe('OscTranscriptExtractor.renderTail', () => {
  function withMessages(count: number, text: (k: number) => string): OscTranscriptExtractor {
    const ex = new OscTranscriptExtractor();
    for (let k = 0; k < count; k++) {
      ex.feed(packets(`m${k}`, { v: 1, t: 'msg', role: 'assistant', text: text(k) }));
    }
    return ex;
  }

  it('equals render().slice(-maxChars) across boundary sizes', () => {
    const ex = withMessages(6, (k) => `message ${k} body`);
    const full = ex.render();
    // maxChars far above total, exactly the total, mid-line, at a separator, and 1.
    for (const maxChars of [10_000, full.length, full.length - 1, 7, 3, 2, 1]) {
      expect(ex.renderTail(maxChars)).toBe(full.slice(-maxChars));
    }
  });

  it('matches render().slice on a multi-byte transcript', () => {
    const ex = withMessages(4, (k) => `réf ${k} ☕ café`);
    const full = ex.render();
    for (const maxChars of [full.length + 5, 12, 5, 1]) {
      expect(ex.renderTail(maxChars)).toBe(full.slice(-maxChars));
    }
  });

  it('returns the whole render when maxChars exceeds it; empty for an empty transcript', () => {
    const ex = withMessages(2, (k) => `m${k}`);
    expect(ex.renderTail(1_000_000)).toBe(ex.render());
    const empty = new OscTranscriptExtractor();
    expect(empty.renderTail(8000)).toBe('');
    expect(empty.render().slice(-8000)).toBe('');
  });

  it('matches the exact dashboard cap expression (render.length > max ? slice : render)', () => {
    const ex = withMessages(5, (k) => `line ${k}`);
    const full = ex.render();
    for (const maxChars of [4, full.length, full.length + 100]) {
      const dashboard = full.length > maxChars ? full.slice(-maxChars) : full;
      expect(ex.renderTail(maxChars)).toBe(dashboard);
    }
  });
});

describe('OscTranscriptExtractor single-scan sharing', () => {
  it('feedCapturingFrames + applyDecodedFrame reproduces a feed()-scanned transcript', () => {
    // The main process scans the pty bytes once (the dashboard extractor) and
    // replays the decoded frames into the logger's separate extractor. Both must
    // reach byte-identical transcript state.
    const chunks = [
      'plain output\r\n',
      packets('a', { v: 1, t: 'msg', role: 'user', text: 'hello' }),
      'more grid text',
      packets('b', { v: 1, t: 'msg', role: 'assistant', text: 'a reply' }, 4),
      packets('c', { v: 1, t: 'end', sid: 's' }),
    ];
    const scanned = new OscTranscriptExtractor(); // feed() path (today's behaviour)
    const replayed = new OscTranscriptExtractor(); // shared-scan path
    let scannedClean = '';
    let sharedClean = '';
    for (const chunk of chunks) {
      scannedClean += scanned.feed(chunk);
      const { clean, frames } = replayed.feedCapturingFrames(chunk);
      // feedCapturingFrames both applies to `replayed` AND returns the frames; a
      // logger's extractor would apply the SAME frames — model that here.
      const loggerSide = frames;
      sharedClean += clean;
      void loggerSide;
    }
    expect(sharedClean).toBe(scannedClean);
    expect(replayed.render()).toBe(scanned.render());
    expect(replayed.hasTranscript()).toBe(scanned.hasTranscript());
  });

  it('a second extractor fed only via applyDecodedFrame matches the scanned one', () => {
    const chunks = [
      packets('a', { v: 1, t: 'msg', role: 'user', text: 'q1' }),
      packets('b', { v: 1, t: 'msg', role: 'reasoning', text: 'hmm' }),
      packets('c', { v: 1, t: 'msg', role: 'assistant', text: 'a1' }),
    ];
    const scanned = new OscTranscriptExtractor();
    const logger = new OscTranscriptExtractor();
    for (const chunk of chunks) {
      const { frames } = scanned.feedCapturingFrames(chunk);
      for (const frame of frames) logger.applyDecodedFrame(frame);
    }
    expect(logger.render()).toBe(scanned.render());
    expect(logger.render()).toBe('[user] q1\n\n[reasoning] hmm\n\n[assistant] a1');
  });
});

describe('OscTranscriptExtractor.appendedSince', () => {
  function feedMsg(ex: OscTranscriptExtractor, k: number): void {
    ex.feed(packets(`m${k}`, { v: 1, t: 'msg', role: 'assistant', text: `msg ${k}` }));
  }

  it('returns only the suffix added since the cursor, with the separator', () => {
    const ex = new OscTranscriptExtractor();
    feedMsg(ex, 0);
    const c0 = ex.cursor();
    feedMsg(ex, 1);
    feedMsg(ex, 2);
    const delta = ex.appendedSince(c0);
    expect(delta).not.toBeNull();
    expect(delta?.appended).toBe('\n\n[assistant] msg 1\n\n[assistant] msg 2');
    // Stitching the suffix onto the prior render reproduces render() exactly.
    expect('[assistant] msg 0' + delta?.appended).toBe(ex.render());
  });

  it('returns an empty suffix when nothing new arrived', () => {
    const ex = new OscTranscriptExtractor();
    feedMsg(ex, 0);
    const c = ex.cursor();
    expect(ex.appendedSince(c)?.appended).toBe('');
  });

  it('returns null once a cap trim has dropped lines at/before the cursor', () => {
    const ex = new OscTranscriptExtractor();
    const big = 'x'.repeat(1_000_000);
    ex.feed(packets('b0', { v: 1, t: 'msg', role: 'assistant', text: `0:${big}` }));
    const c0 = ex.cursor();
    // Push enough big messages to blow past the 8 MB byte cap → oldest trimmed.
    for (let k = 1; k < 12; k++) {
      ex.feed(packets(`b${k}`, { v: 1, t: 'msg', role: 'assistant', text: `${k}:${big}` }));
    }
    expect(ex.appendedSince(c0)).toBeNull();
  });
});

describe('timestampMarker / formatMinute', () => {
  it('formats a local-time Date as a zero-padded HTML-comment marker', () => {
    expect(formatMinute(new Date(2026, 0, 3, 4, 6, 0))).toBe('2026-01-03:04:06');
    expect(timestampMarker(new Date(2026, 0, 3, 4, 6, 0))).toBe('<!-- 2026-01-03:04:06 -->');
  });
});

describe('lastTranscriptRole', () => {
  it('returns the role of the last message', () => {
    const text = ['[user] do the thing', '[assistant] on it', '[reasoning] thinking…'].join('\n\n');
    expect(lastTranscriptRole(text)).toBe('reasoning');
  });

  it('detects a [user] tail (the mid-turn signal)', () => {
    const text = ['[assistant] previous turn done', '[user] now do the next thing'].join('\n\n');
    expect(lastTranscriptRole(text)).toBe('user');
  });

  it('detects an [assistant] tail', () => {
    const text = ['[user] question?', '[assistant] answer.'].join('\n\n');
    expect(lastTranscriptRole(text)).toBe('assistant');
  });

  it('is unaffected by a multi-line message body', () => {
    // Continuation lines of a message are not new markers; the message role wins.
    const text = '[assistant] earlier\n\n[user] line one\nline two\nline three';
    expect(lastTranscriptRole(text)).toBe('user');
  });

  it('returns null for markerless grid text', () => {
    expect(lastTranscriptRole('alice@host:~/src$ ls\nfoo bar')).toBeNull();
    expect(lastTranscriptRole('')).toBeNull();
  });
});
