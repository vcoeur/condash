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

/** Cap on accumulated transcript lines. The grid body is bounded by xterm
 * scrollback, but the transcript is not — without a cap a long-lived agent
 * session grows `lines` for the life of the pty. Oldest lines are dropped;
 * generous enough that a real conversation never hits it. Exported for
 * tests. */
export const MAX_TRANSCRIPT_LINES = 20_000;

/** Cap on the accumulated transcript **bytes**, alongside the line cap. A single
 * message line can reach a few MB (a big assistant turn), so 20k lines alone
 * doesn't bound memory — a handful of huge lines can still hold tens of MB
 * resident and, with disk logging on, be rewritten every flush (review G9).
 * Oldest lines are dropped once total content exceeds this, down to (but never
 * below) a single line. Generous enough that a real conversation never hits it.
 * Exported for tests. */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** Bail-out threshold for an unterminated OSC sequence. A cooperating writer
 * terminates each packet promptly; past this size we stop waiting, re-emit
 * the buffered bytes to the passthrough (so the grid keeps rendering instead
 * of being silenced forever), and resume normal scanning. Exported for
 * tests. */
export const MAX_OSC_BUFFER_CHARS = 512 * 1024;

/** Cap on concurrently-pending (incomplete) frame reassemblies. Oldest is
 * evicted on overflow — a writer that never completes its frames must not
 * accumulate state without bound. Exported for tests. */
export const MAX_PENDING_FRAMES = 32;

/** Cap on the accumulated base64 payload of one pending frame; a frame past
 * it is discarded outright. */
const MAX_FRAME_B64_CHARS = 4 * 1024 * 1024;

/** One decoded transcript frame. */
export interface TranscriptFrame {
  v: number;
  t: string;
  sid?: string;
  mid?: string;
  role?: string;
  text?: string;
}

/** An opaque watermark into the rendered transcript: how many lines have ever
 * been appended and how many the caps have ever trimmed off the front. Paired
 * with {@link OscTranscriptExtractor.appendedSince} so a caller that already
 * rendered up to a prior cursor appends only the new suffix, and detects a cap
 * trim that dropped lines it had already written. */
export interface TranscriptCursor {
  /** Total lines ever appended (monotonic) at snapshot time. */
  appended: number;
  /** Total lines ever trimmed off the front (monotonic) at snapshot time. */
  trimmed: number;
}

/** The transcript suffix accumulated since a prior {@link TranscriptCursor}. */
export interface TranscriptDelta {
  /** Body text to append after the previously-rendered body — including the
   * leading `\n\n` separator when the prior body was non-empty; '' when no new
   * lines arrived. */
  appended: string;
  /** The up-to-date cursor to store and pass back on the next call. */
  cursor: TranscriptCursor;
}

/**
 * Render one neutral message frame as a transcript line. Single-sourced so the
 * in-band OSC extractor and the file-based sidecar reader format messages
 * identically (`[role] text`), keeping the summarizer's input shape stable
 * regardless of which transport delivered the frame.
 *
 * @param role - The frame's `role` (`user` / `reasoning` / anything else → `assistant`).
 * @param text - The message text.
 * @returns The `[role] text` line.
 */
export function transcriptLine(role: string | undefined, text: string): string {
  const who = role === 'user' ? 'user' : role === 'reasoning' ? 'reasoning' : 'assistant';
  return `[${who}] ${text}`;
}

/** Role tag of the LAST message in rendered transcript text, or null when the
 * text carries no `[role]` markers (e.g. a plain-shell grid fallback, where the
 * summarizer reads cleaned buffer rather than a transcript). Reads back the
 * `[user]`/`[assistant]`/`[reasoning]` shape {@link transcriptLine} writes.
 *
 * The dashboard uses this to detect a mid-turn agent: the OSC emitter frames a
 * chunk only on `UserPromptSubmit` and each assistant `Stop`, so a `[user]` tail
 * means the user's request was the last framed message and no assistant turn has
 * completed since — the agent is working on it, not waiting on the user.
 *
 * @param text - Rendered transcript text (one `[role] …` line per message start).
 * @returns The last message's role, or null when no marker is present.
 */
export function lastTranscriptRole(text: string): 'user' | 'assistant' | 'reasoning' | null {
  const marker = /^\[(user|assistant|reasoning)\] /gm;
  let role: 'user' | 'assistant' | 'reasoning' | null = null;
  for (const match of text.matchAll(marker)) {
    role = match[1] as 'user' | 'assistant' | 'reasoning';
  }
  return role;
}

export class OscTranscriptExtractor {
  /** Unconsumed tail — holds an incomplete sequence (or a partial PREFIX) that
   * spans feed boundaries. */
  private buf = '';
  /** Reassembly state per frameId: how many pieces and which we've seen, plus
   * the accumulated payload size for the per-frame cap. */
  private pieces = new Map<string, { n: number; got: Map<number, string>; chars: number }>();
  private lines: string[] = [];
  /** Byte length of `lines[i]`, parallel array, so the byte cap trims without
   * re-measuring the whole transcript on every append. */
  private lineBytes: number[] = [];
  /** Running sum of `lineBytes` — the value the byte cap is enforced against. */
  private totalBytes = 0;
  private captured = false;
  /** Monotonic count of lines ever appended (never decremented by a cap trim).
   * Backs the {@link cursor} watermark that drives the logger's incremental,
   * append-only flush. */
  private appendedCount = 0;
  /** Monotonic count of lines ever dropped off the front by a cap trim. A
   * change since a caller's watermark means its already-written prefix is
   * stale. */
  private trimmedCount = 0;

  /** Feed a raw pty chunk. Returns the chunk with our OSC sequences stripped,
   * for the caller to forward to the grid renderer. Incomplete sequences are
   * buffered until the rest arrives. */
  feed(data: string): string {
    return this.scan(data, null);
  }

  /** Like {@link feed}, but also returns every transcript frame this chunk
   * completed. Lets the main process scan the pty bytes **once** — the
   * session-wide dashboard extractor does the scan — and hand the already
   * decoded frames to the disk logger's separate extractor via
   * {@link applyDecodedFrame}, so the same bytes are never OSC-scanned twice. */
  feedCapturingFrames(data: string): { clean: string; frames: TranscriptFrame[] } {
    const frames: TranscriptFrame[] = [];
    const clean = this.scan(data, frames);
    return { clean, frames };
  }

  /** Scan a raw pty chunk: strip our OSC sequences (returned for the grid
   * renderer) and apply any completed frames to this extractor. When
   * `framesOut` is provided, each applied frame is also collected there. */
  private scan(data: string, framesOut: TranscriptFrame[] | null): string {
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
        // Incomplete sequence; keep it (starts with PREFIX) for the next
        // feed — unless it has grown past any plausible packet size, in
        // which case the terminator is never coming: re-emit the buffered
        // bytes so the grid log isn't silenced for the rest of the session.
        if (this.buf.length > MAX_OSC_BUFFER_CHARS) {
          clean += this.buf;
          this.buf = '';
        }
        break;
      }
      this.ingest(this.buf.slice(afterPrefix, end), framesOut);
      this.buf = this.buf.slice(end + termLen);
    }
    return clean;
  }

  /** Parse one packet body: `<frameId>;<i>;<n>;<base64piece>`. When a frame
   * completes it is applied and, if `framesOut` is set, collected there. */
  private ingest(body: string, framesOut: TranscriptFrame[] | null): void {
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
      // Cap pending reassemblies; Map iteration order = insertion order, so
      // the first key is the oldest never-completed frame.
      if (this.pieces.size >= MAX_PENDING_FRAMES) {
        const oldest = this.pieces.keys().next().value;
        if (oldest !== undefined) this.pieces.delete(oldest);
      }
      entry = { n, got: new Map(), chars: 0 };
      this.pieces.set(id, entry);
    }
    entry.chars += piece.length;
    if (entry.chars > MAX_FRAME_B64_CHARS) {
      this.pieces.delete(id);
      return;
    }
    entry.got.set(i, piece);
    if (entry.got.size !== entry.n) return;
    this.pieces.delete(id);
    let b64 = '';
    for (let k = 0; k < entry.n; k++) b64 += entry.got.get(k) ?? '';
    try {
      const frame = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as TranscriptFrame;
      this.applyDecodedFrame(frame);
      if (framesOut) framesOut.push(frame);
    } catch {
      /* malformed frame — ignore, never break capture */
    }
  }

  /** Apply one already-decoded frame to this extractor's state — no OSC
   * byte-scan. {@link feedCapturingFrames} returns the frames a single scan
   * produced; a second extractor replays them here to reach the same state the
   * raw stream would, so the bytes are scanned once in the main process. */
  applyDecodedFrame(frame: TranscriptFrame): void {
    if (frame.t === 'msg' && typeof frame.text === 'string') {
      this.captured = true;
      this.appendLine(transcriptLine(frame.role, frame.text));
    } else if (frame.t === 'end') {
      this.captured = true;
    }
  }

  /** Append a transcript line and trim the oldest entries back under both the
   * line cap and the byte cap. Single-sourced so message lines and timestamp
   * markers enforce identical bounds. */
  private appendLine(line: string): void {
    this.lines.push(line);
    this.appendedCount++;
    const bytes = Buffer.byteLength(line, 'utf8');
    this.lineBytes.push(bytes);
    this.totalBytes += bytes;
    // Drop oldest until under both caps, but never below one line — a single
    // over-budget message is kept whole rather than rendering an empty body.
    while (
      this.lines.length > MAX_TRANSCRIPT_LINES ||
      (this.totalBytes > MAX_TRANSCRIPT_BYTES && this.lines.length > 1)
    ) {
      this.lines.shift();
      this.totalBytes -= this.lineBytes.shift() ?? 0;
      this.trimmedCount++;
    }
  }

  /** Snapshot the current append/trim watermark — see {@link TranscriptCursor}. */
  cursor(): TranscriptCursor {
    return { appended: this.appendedCount, trimmed: this.trimmedCount };
  }

  /** Compute what to append to a body last rendered at `prev` to bring it up to
   * date, or `null` when a cap trim has dropped a line at or before `prev` — in
   * which case the caller's on-disk prefix is stale and it must re-render the
   * whole body. With a fresh `prev` (no trim since), the returned `appended` is
   * exactly the suffix {@link render} would now add. */
  appendedSince(prev: TranscriptCursor): TranscriptDelta | null {
    // A trim removes only the oldest (already-written) lines, so any growth in
    // `trimmed` invalidates the caller's prefix.
    if (prev.trimmed !== this.trimmedCount) return null;
    // Global line index `prev.appended` sits at this array offset, since the
    // array currently holds indices [trimmedCount, appendedCount).
    const fromIndex = prev.appended - this.trimmedCount;
    if (fromIndex < 0 || fromIndex > this.lines.length) return null;
    const cursor = this.cursor();
    const newLines = this.lines.slice(fromIndex);
    if (newLines.length === 0) return { appended: '', cursor };
    // Leading separator only when a prior (non-empty) body already existed.
    const sep = prev.appended > prev.trimmed ? '\n\n' : '';
    return { appended: sep + newLines.join('\n\n'), cursor };
  }

  /** The last `maxChars` characters of {@link render}, built by walking lines
   * backwards and joining only the needed suffix — so a multi-MB transcript is
   * never fully re-joined just to read its tail. For `maxChars > 0` this is
   * byte-for-byte `render().slice(-maxChars)`: both are a whole-line-or-shorter
   * suffix of the same `\n\n`-joined body. Returns '' for `maxChars <= 0`. */
  renderTail(maxChars: number): string {
    if (maxChars <= 0) return '';
    const parts: string[] = [];
    let total = 0;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (parts.length > 0) total += 2; // the '\n\n' separator to the next line
      total += this.lines[i].length;
      parts.push(this.lines[i]);
      if (total >= maxChars) break;
    }
    parts.reverse();
    const joined = parts.join('\n\n');
    return joined.length > maxChars ? joined.slice(-maxChars) : joined;
  }

  /** Append a pre-formatted timestamp marker line to the transcript. The
   * SessionLogger owns the content + cadence gate (so one policy drives both
   * transcript and grid logs) and calls this when a marker is due. The marker
   * lands between whole messages, so it stays at a clean message boundary.
   *
   * @param markerLine the full `<!-- YYYY-MM-DD:HH:MM -->` line to append.
   */
  pushTimestampMarker(markerLine: string): void {
    this.appendLine(markerLine);
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

/** Format a local-time `Date` as `YYYY-MM-DD:HH:MM` for a timestamp marker. */
export function formatMinute(when: Date): string {
  const yyyy = String(when.getFullYear());
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const dd = String(when.getDate()).padStart(2, '0');
  const hh = String(when.getHours()).padStart(2, '0');
  const mi = String(when.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}:${hh}:${mi}`;
}

/** Build a full `<!-- YYYY-MM-DD:HH:MM -->` HTML-comment marker line for
 * `when`. Single-sourced so transcript and grid logs emit an identical marker:
 * invisible in rendered markdown, trivially skippable by a parser, local time
 * matching the log filename's `HHMMSS`. */
export function timestampMarker(when: Date): string {
  return `<!-- ${formatMinute(when)} -->`;
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
