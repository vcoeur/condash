import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileTranscript, sidecarTranscriptPath } from './file-transcript';
import { OscTranscriptExtractor } from './osc-transcript';

const dir = mkdtempSync(join(tmpdir(), 'condash-sidecar-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write NDJSON `frames` to a fresh sidecar file and return its path. */
function sidecar(name: string, frames: unknown[]): string {
  const path = join(dir, `${name}.ndjson`);
  writeFileSync(path, frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  return path;
}

describe('sidecarTranscriptPath', () => {
  it('keys by sid under the conception .condash/transcripts dir', () => {
    expect(sidecarTranscriptPath('/home/u/conc', 't-abc123')).toBe(
      '/home/u/conc/.condash/transcripts/t-abc123.ndjson',
    );
  });
});

describe('readFileTranscript', () => {
  it('renders neutral frames as [role] blocks joined by blank lines', () => {
    const path = sidecar('basic', [
      { v: 1, t: 'msg', role: 'user', text: 'hello' },
      { v: 1, t: 'msg', role: 'reasoning', text: 'thinking' },
      { v: 1, t: 'msg', role: 'assistant', text: 'hi there' },
    ]);
    expect(readFileTranscript(path)).toBe(
      '[user] hello\n\n[reasoning] thinking\n\n[assistant] hi there',
    );
  });

  it('produces the same text as the OSC extractor for the same frames', () => {
    const frames = [
      { v: 1, t: 'msg', role: 'user', text: 'q' },
      { v: 1, t: 'msg', role: 'assistant', text: 'a' },
    ];
    const ext = new OscTranscriptExtractor();
    for (const f of frames) {
      const b64 = Buffer.from(JSON.stringify(f), 'utf8').toString('base64');
      ext.feed(`\x1b]7373;agent-transcript;x;0;1;${b64}\x07`);
    }
    expect(readFileTranscript(sidecar('parity', frames))).toBe(ext.render());
  });

  it('treats an unknown role as assistant', () => {
    const path = sidecar('role', [{ v: 1, t: 'msg', role: 'tool', text: 'x' }]);
    expect(readFileTranscript(path)).toBe('[assistant] x');
  });

  it('skips malformed and non-message lines without throwing', () => {
    const path = join(dir, 'malformed.ndjson');
    writeFileSync(
      path,
      [
        '{not json}',
        JSON.stringify({ v: 1, t: 'msg', role: 'user', text: 'kept' }),
        JSON.stringify({ v: 1, t: 'end' }), // no text — skipped
        '',
        JSON.stringify({ v: 1, t: 'msg', role: 'assistant', text: 'also kept' }),
      ].join('\n'),
    );
    expect(readFileTranscript(path)).toBe('[user] kept\n\n[assistant] also kept');
  });

  it('returns empty string for a missing or empty file', () => {
    expect(readFileTranscript(join(dir, 'nope.ndjson'))).toBe('');
    const empty = join(dir, 'empty.ndjson');
    writeFileSync(empty, '');
    expect(readFileTranscript(empty)).toBe('');
  });

  it('tail-reads a large file, dropping the partial first line', () => {
    const path = join(dir, 'large.ndjson');
    const pad = 'x'.repeat(2000);
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({ v: 1, t: 'msg', role: 'assistant', text: `${pad}-${i}` }));
    }
    writeFileSync(path, lines.join('\n') + '\n');
    const out = readFileTranscript(path);
    // The newest line is always present; the oldest is dropped past the tail cap.
    expect(out).toContain('-399');
    expect(out).not.toContain('-0\n');
  });
});
