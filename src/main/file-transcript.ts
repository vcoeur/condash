/**
 * File-based sidecar transcript: the reliable transport for a cooperating
 * program's transcript.
 *
 * condash assigns each spawned tab a unique sidecar path (via the
 * `CONDASH_TRANSCRIPT_FILE` env var). A cooperating program — today the agedum
 * claude hook / opencode plugin — appends one **neutral frame** per line
 * (newline-delimited JSON of {@link TranscriptFrame}) to that file. condash
 * reads it back here.
 *
 * This replaces the in-band OSC-7373 echo for the agent case: that echo routes
 * the transcript through the program's `/dev/tty`, which does not reliably reach
 * condash's pty (a hook may run without condash's controlling terminal), so the
 * frames silently never arrive. A file the writer and reader both name by an
 * absolute path has no such transport gap, and works identically whether or not
 * the launch is sandboxed.
 *
 * Like {@link OscTranscriptExtractor}, this module is harness-blind: it knows
 * only the neutral frame shape, never which program produced it.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transcriptLine, type TranscriptFrame } from './osc-transcript';

/** Tail bound: only the last this-many bytes of the sidecar are read per call.
 *  The summarizer wants recent text and caps its own input, so reading the
 *  whole (potentially multi-MB) transcript every tick would be wasted work. */
const MAX_READ_BYTES = 256 * 1024;

/**
 * The per-tab sidecar path for a session: a gitignored file under the
 * conception's `.condash/transcripts/`. Keyed by the condash session id (not
 * the cwd), so two tabs sharing a working directory never collide.
 *
 * @param conceptionPath - Absolute path of the active conception.
 * @param sid - The condash session id.
 * @returns The absolute sidecar path.
 */
export function sidecarTranscriptPath(conceptionPath: string, sid: string): string {
  return join(conceptionPath, '.condash', 'transcripts', `${sid}.ndjson`);
}

/** Read at most the last `MAX_READ_BYTES` of a file, dropping a leading partial
 *  line when the file was longer. Returns '' for an absent/empty/unreadable
 *  file. */
function readTail(filePath: string): string {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return '';
  }
  if (size === 0) return '';
  if (size <= MAX_READ_BYTES) {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return '';
  }
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    readSync(fd, buf, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
    const raw = buf.toString('utf8');
    const nl = raw.indexOf('\n');
    return nl >= 0 ? raw.slice(nl + 1) : raw;
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a sidecar transcript and render it as plain text, identical in shape to
 * {@link OscTranscriptExtractor.render} (`[role] text` blocks joined by blank
 * lines). Malformed lines are skipped, never fatal.
 *
 * @param filePath - The sidecar path (see {@link sidecarTranscriptPath}).
 * @returns The rendered transcript, or '' when the file is absent/empty/has no
 *   usable frames.
 */
export function readFileTranscript(filePath: string): string {
  const raw = readTail(filePath);
  if (!raw) return '';
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let frame: TranscriptFrame;
    try {
      frame = JSON.parse(line) as TranscriptFrame;
    } catch {
      continue; // partial / non-JSON line — skip, never break capture
    }
    if (frame.t === 'msg' && typeof frame.text === 'string') {
      lines.push(transcriptLine(frame.role, frame.text));
    }
  }
  return lines.join('\n\n');
}
