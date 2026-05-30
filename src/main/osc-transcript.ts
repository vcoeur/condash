/**
 * Extractor for a **neutral "agent transcript over OSC"** protocol.
 *
 * Some full-screen TUIs (anything on the alternate screen) never leave their
 * conversation in the terminal grid — only the current frame is ever on
 * screen, so the rendered-buffer snapshot the SessionLogger writes is just the
 * last viewport. To capture a clean transcript without parsing escape-sequence
 * redraws, a cooperating program may emit its transcript **in-band** as an OSC
 * escape the terminal ignores for display:
 *
 *   ESC ] 7373 ; agent-transcript ; <frameId> ; <i> ; <n> ; <base64piece> BEL
 *   (BEL = 0x07; the ST form `ESC \` is also accepted as the terminator)
 *
 * A frame's base64 payload may be split across `n` pieces (indices `0..n-1`)
 * to keep each OSC write small; this extractor reassembles them per
 * `frameId`, base64-decodes the concatenation, and parses a JSON frame:
 *
 *   { "v":1, "t":"msg", "sid":string, "mid":string,
 *     "role":"user"|"assistant", "text":string }
 *   { "v":1, "t":"end", "sid":string }
 *
 * This module is deliberately **harness-blind**: it knows only the generic OSC
 * protocol, never which program produced it. Any tool that speaks the protocol
 * gets a clean transcript captured; condash never special-cases a harness.
 *
 * Usage: feed every raw pty chunk through `feed()`, which returns the chunk
 * with our OSC sequences removed (so the remainder still drives the grid
 * render). If `hasTranscript()` is true at flush time, prefer `render()` over
 * the grid snapshot for the log body.
 */

/** Marker prefix every protocol packet starts with. */
const PREFIX = '\x1b]7373;agent-transcript;';
const BEL = '\x07';
const ST = '\x1b\\';

/** One decoded transcript frame. */
export interface TranscriptFrame {
  v: number;
  t: string;
  sid?: string;
  mid?: string;
  role?: string;
  text?: string;
}

export class OscTranscriptExtractor {
  /** Unconsumed tail — holds an incomplete sequence (or a partial PREFIX) that
   * spans feed boundaries. */
  private buf = '';
  /** Reassembly state per frameId: how many pieces and which we've seen. */
  private pieces = new Map<string, { n: number; got: Map<number, string> }>();
  private lines: string[] = [];
  private captured = false;

  /** Feed a raw pty chunk. Returns the chunk with our OSC sequences stripped,
   * for the caller to forward to the grid renderer. Incomplete sequences are
   * buffered until the rest arrives. */
  feed(data: string): string {
    this.buf += data;
    let clean = '';
    for (;;) {
      const start = this.buf.indexOf(PREFIX);
      if (start === -1) {
        // No complete marker. Hold back only a possible partial PREFIX at the
        // tail so a marker split across feeds isn't emitted as visible text.
        const keep = partialPrefixLen(this.buf);
        clean += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      clean += this.buf.slice(0, start);
      this.buf = this.buf.slice(start);
      const afterPrefix = PREFIX.length;
      const bel = this.buf.indexOf(BEL, afterPrefix);
      const st = this.buf.indexOf(ST, afterPrefix);
      let end = -1;
      let termLen = 0;
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel;
        termLen = BEL.length;
      } else if (st !== -1) {
        end = st;
        termLen = ST.length;
      }
      if (end === -1) {
        // Incomplete sequence; keep it (starts with PREFIX) for the next feed.
        break;
      }
      this.ingest(this.buf.slice(afterPrefix, end));
      this.buf = this.buf.slice(end + termLen);
    }
    return clean;
  }

  /** Parse one packet body: `<frameId>;<i>;<n>;<base64piece>`. */
  private ingest(body: string): void {
    const sep1 = body.indexOf(';');
    const sep2 = body.indexOf(';', sep1 + 1);
    const sep3 = body.indexOf(';', sep2 + 1);
    if (sep1 === -1 || sep2 === -1 || sep3 === -1) return;
    const id = body.slice(0, sep1);
    const i = Number(body.slice(sep1 + 1, sep2));
    const n = Number(body.slice(sep2 + 1, sep3));
    const piece = body.slice(sep3 + 1);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n <= 0 || i < 0 || i >= n) return;
    let entry = this.pieces.get(id);
    if (!entry) {
      entry = { n, got: new Map() };
      this.pieces.set(id, entry);
    }
    entry.got.set(i, piece);
    if (entry.got.size !== entry.n) return;
    this.pieces.delete(id);
    let b64 = '';
    for (let k = 0; k < entry.n; k++) b64 += entry.got.get(k) ?? '';
    try {
      const frame = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as TranscriptFrame;
      this.applyFrame(frame);
    } catch {
      /* malformed frame — ignore, never break capture */
    }
  }

  private applyFrame(frame: TranscriptFrame): void {
    if (frame.t === 'msg' && typeof frame.text === 'string') {
      this.captured = true;
      const who =
        frame.role === 'user' ? 'user' : frame.role === 'reasoning' ? 'reasoning' : 'assistant';
      this.lines.push(`[${who}] ${frame.text}`);
    } else if (frame.t === 'end') {
      this.captured = true;
    }
  }

  /** True once any protocol frame has been decoded — the caller should then
   * prefer `render()` over the grid snapshot. */
  hasTranscript(): boolean {
    return this.captured;
  }

  /** The accumulated transcript as plain text. */
  render(): string {
    return this.lines.join('\n\n');
  }
}

/** Length of the longest suffix of `buf` that is a proper prefix of the marker
 * PREFIX — i.e. a marker possibly split across the feed boundary. */
function partialPrefixLen(buf: string): number {
  const max = Math.min(buf.length, PREFIX.length - 1);
  for (let k = max; k > 0; k--) {
    if (PREFIX.startsWith(buf.slice(buf.length - k))) return k;
  }
  return 0;
}
