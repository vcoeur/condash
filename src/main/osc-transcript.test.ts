import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { OscTranscriptExtractor } from './osc-transcript';

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
    const ex = new OscTranscriptExtractor();
    ex.feed(packets('0', { v: 1, t: 'msg', role: 'user', text: 'q' }));
    ex.feed(packets('1', { v: 1, t: 'msg', role: 'assistant', text: 'a' }));
    ex.feed(packets('2', { v: 1, t: 'end', sid: 's' }));
    expect(ex.render()).toBe('[user] q\n\n[assistant] a');
  });

  it('ignores malformed packets without breaking', () => {
    const ex = new OscTranscriptExtractor();
    const clean = ex.feed(`${PREFIX}bad;packet${BEL}tail`);
    expect(clean).toBe('tail');
    expect(ex.hasTranscript()).toBe(false);
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
