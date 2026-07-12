import { describe, expect, it } from 'vitest';
import { closeMilestoneSubject, extractClosedEntries } from './close-milestone';

const CLOSED_README = [
  '---',
  'date: 2026-07-10',
  'status: done',
  '---',
  '',
  '# Alpha',
  '',
  '## Timeline',
  '',
  '- 2026-07-10 — Opened.',
  '- 2026-07-11 — PR #12 merged.',
  '- 2026-07-12 — Closed. Shipped v1.2.0.',
  '- 2026-07-12 — Checked knowledge promotion',
  '',
].join('\n');

describe('extractClosedEntries', () => {
  it('extracts the summary of a Closed. entry amid timeline noise', () => {
    expect(extractClosedEntries(CLOSED_README)).toEqual(['Shipped v1.2.0.']);
  });

  it('extracts a bare Closed. entry as an empty summary', () => {
    expect(extractClosedEntries('- 2026-07-12 — Closed.')).toEqual(['']);
  });

  it('returns entries in file order', () => {
    const text = [
      '- 2026-05-01 — Closed. First outcome.',
      '- 2026-06-01 — Reopened.',
      '- 2026-07-01 — Closed. Second outcome.',
    ].join('\n');
    expect(extractClosedEntries(text)).toEqual(['First outcome.', 'Second outcome.']);
  });

  it('finds nothing in a README without a close', () => {
    expect(extractClosedEntries('# Alpha\n\n## Timeline\n\n- 2026-07-10 — Opened.\n')).toEqual([]);
    expect(extractClosedEntries('')).toEqual([]);
  });
});

describe('closeMilestoneSubject', () => {
  it('composes the subject from the new close, moving the trailing period', () => {
    expect(closeMilestoneSubject('2026-07-10-alpha', [], ['Shipped v1.2.0.'])).toBe(
      'Close 2026-07-10-alpha. Outcome: Shipped v1.2.0.',
    );
  });

  it('ends with exactly one period when the summary carries none', () => {
    expect(closeMilestoneSubject('2026-07-10-alpha', [], ['Shipped v1.2.0'])).toBe(
      'Close 2026-07-10-alpha. Outcome: Shipped v1.2.0.',
    );
  });

  it('yields the bare form for a summary-less close', () => {
    expect(closeMilestoneSubject('2026-07-10-alpha', [], [''])).toBe('Close 2026-07-10-alpha.');
  });

  it('uses the last new entry on a reopen-then-close', () => {
    expect(
      closeMilestoneSubject(
        '2026-07-10-alpha',
        ['First outcome.'],
        ['First outcome.', 'Second outcome.'],
      ),
    ).toBe('Close 2026-07-10-alpha. Outcome: Second outcome.');
  });

  it('returns null when the sweep introduces no new close', () => {
    expect(closeMilestoneSubject('2026-07-10-alpha', ['Shipped.'], ['Shipped.'])).toBeNull();
    expect(closeMilestoneSubject('2026-07-10-alpha', [], [])).toBeNull();
  });

  it('treats a brand-new README (absent from HEAD) as all-new entries', () => {
    expect(
      closeMilestoneSubject('2026-07-10-alpha', extractClosedEntries(''), ['Done on arrival.']),
    ).toBe('Close 2026-07-10-alpha. Outcome: Done on arrival.');
  });
});
