/**
 * Tests for the knowledge card-metadata reader. The `verifiedAt` it lifts
 * feeds `condash knowledge tree --json` and the knowledge pane, so it has to
 * agree with `knowledge verify` on which stamp describes a file.
 */
import { describe, expect, it } from 'vitest';
import { parseHead } from './knowledge';

describe('parseHead — verifiedAt', () => {
  it('lifts the only stamp', () => {
    const meta = parseHead('# Title\n\n**Verified:** 2026-05-17 x\n\nBody.\n', 'fallback');
    expect(meta.verifiedAt).toBe('2026-05-17');
  });

  it('is undefined without a stamp', () => {
    expect(parseHead('# Title\n\nBody.\n', 'fallback').verifiedAt).toBeUndefined();
  });

  it('takes the oldest stamp, not the first or the last', () => {
    // `knowledge verify` judges a sectioned file on its oldest stamp; a
    // reader that took the first (or, as this one did, the last) reported a
    // different date for the same file (condash#512).
    const raw = [
      '# Title',
      '',
      '**Verified:** 2026-08-14 head',
      '',
      'Lead paragraph.',
      '',
      '## Section',
      '',
      '**Verified:** 2026-05-04 section',
      '',
      '## Other',
      '',
      '**Verified:** 2026-07-01 other',
      '',
    ].join('\n');
    expect(parseHead(raw, 'fallback').verifiedAt).toBe('2026-05-04');
  });

  it('ignores a stamp inside a fenced example', () => {
    const raw = [
      '# Title',
      '',
      '**Verified:** 2026-08-14 head',
      '',
      '```markdown',
      '**Verified:** 2020-01-01 example',
      '```',
      '',
    ].join('\n');
    expect(parseHead(raw, 'fallback').verifiedAt).toBe('2026-08-14');
  });

  it('ignores a stamp inside a tilde-fenced example too', () => {
    // A local backtick-only toggle read this as the file's own date, so
    // `tree --json` reported a stamp `knowledge verify` had ignored.
    const raw = [
      '# Title',
      '',
      '**Verified:** 2026-08-14 head',
      '',
      '~~~markdown',
      '**Verified:** 2020-01-01 example',
      '~~~',
      '',
    ].join('\n');
    expect(parseHead(raw, 'fallback').verifiedAt).toBe('2026-08-14');
  });
});
