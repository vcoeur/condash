import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addStep,
  CLOSED_LINE,
  editStepText,
  parseTimelineEntries,
  toggleStep,
  transitionStatus,
} from './mutate';
import { closeMilestoneSubject, extractClosedEntries } from './sync/close-milestone';

describe('addStep', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'addstep-'));
    path = join(dir, 'README.md');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('appends after existing steps', async () => {
    await fs.writeFile(
      path,
      ['# T', '', '## Steps', '', '- [ ] one', '', '## Timeline', ''].join('\n'),
      'utf8',
    );
    await addStep(path, 'two');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('- [ ] one\n- [ ] two');
  });

  it('inserts when section has no steps yet (only blank lines)', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '## Timeline', ''].join('\n'), 'utf8');
    await addStep(path, 'first');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toMatch(/## Steps[\s\S]*- \[ \] first[\s\S]*## Timeline/);
  });

  it('inserts when ## Steps is the last section', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', ''].join('\n'), 'utf8');
    await addStep(path, 'only');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('- [ ] only');
  });

  it('appends a fresh ## Steps section when missing', async () => {
    await fs.writeFile(path, ['# T', '', '## Goal', '', 'x', ''].join('\n'), 'utf8');
    await addStep(path, 'first');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toMatch(/## Goal[\s\S]*## Steps\s+\n- \[ \] first/);
  });

  it('leaves a blank line separator when section was previously empty', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '## Timeline', ''].join('\n'), 'utf8');
    await addStep(path, 'first');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('## Steps\n\n- [ ] first\n\n## Timeline');
  });
});

describe('toggleStep', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'togglestep-'));
    path = join(dir, 'README.md');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('flips the marker on the target line only', async () => {
    await fs.writeFile(
      path,
      ['# T', '', '## Steps', '', '- [ ] one', '- [ ] two', ''].join('\n'),
      'utf8',
    );
    await toggleStep(path, 4, ' ', 'x');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('- [x] one');
    expect(out).toContain('- [ ] two');
  });

  // Note on the `follower` calls below: `withFileQueue` (mutate-shared.ts)
  // keeps an internal promise per path that only receives a rejection
  // handler when a *subsequent* mutation queues on the same path. Queueing
  // a benign follower synchronously keeps an expected rejection from
  // surfacing as a vitest unhandled-rejection error.
  it('refuses on marker drift', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '- [x] one', ''].join('\n'), 'utf8');
    const failing = toggleStep(path, 4, ' ', 'x');
    const follower = toggleStep(path, 4, 'x', 'x');
    await expect(failing).rejects.toThrow(/Drift/);
    await follower;
  });

  it('refuses when the line is not a step', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '- [ ] one', ''].join('\n'), 'utf8');
    const failing = toggleStep(path, 2, ' ', 'x');
    const follower = toggleStep(path, 4, ' ', ' ');
    await expect(failing).rejects.toThrow(/not a step/);
    await follower;
  });

  it('CRLF round-trip: EOLs preserved, only the target line changed', async () => {
    const before = ['# T', '', '## Steps', '', '- [ ] one', '- [ ] two', ''].join('\r\n');
    await fs.writeFile(path, before, 'utf8');
    await toggleStep(path, 4, ' ', 'x');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toBe(['# T', '', '## Steps', '', '- [x] one', '- [ ] two', ''].join('\r\n'));
    // No lone-LF leaked in.
    expect(/[^\r]\n/.test(out)).toBe(false);
  });
});

describe('editStepText', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'editstep-'));
    path = join(dir, 'README.md');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('replaces the step text, keeping the marker', async () => {
    await fs.writeFile(
      path,
      ['# T', '', '## Steps', '', '- [x] old text', '- [ ] two', ''].join('\n'),
      'utf8',
    );
    await editStepText(path, 4, 'old text', 'new text');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('- [x] new text');
    expect(out).toContain('- [ ] two');
    expect(out).not.toContain('old text');
  });

  it('refuses on text drift', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '- [ ] actual', ''].join('\n'), 'utf8');
    const failing = editStepText(path, 4, 'expected', 'new');
    // Benign follower — see the note in the toggleStep suite.
    const follower = editStepText(path, 4, 'actual', 'actual');
    await expect(failing).rejects.toThrow(/Drift/);
    await follower;
  });

  it('rejects empty and multi-line replacements', async () => {
    await fs.writeFile(path, ['# T', '', '## Steps', '', '- [ ] one', ''].join('\n'), 'utf8');
    await expect(editStepText(path, 4, 'one', '  ')).rejects.toThrow(/empty/);
    await expect(editStepText(path, 4, 'one', 'a\nb')).rejects.toThrow(/line breaks/);
  });

  it('CRLF round-trip: EOLs preserved, only the target line changed', async () => {
    const before = ['# T', '', '## Steps', '', '- [ ] one', '- [ ] two', ''].join('\r\n');
    await fs.writeFile(path, before, 'utf8');
    await editStepText(path, 5, 'two', 'two — edited');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toBe(
      ['# T', '', '## Steps', '', '- [ ] one', '- [ ] two — edited', ''].join('\r\n'),
    );
    expect(/[^\r]\n/.test(out)).toBe(false);
  });
});

/** Minimal YAML-frontmatter README with a `## Timeline` section, seeded at
 *  `status`. Used by the done-edge (close / reopen) cases. */
function doneEdgeReadme(status: string): string {
  return [
    '---',
    'date: 2026-05-08',
    'kind: project',
    `status: ${status}`,
    '---',
    '',
    '# T',
    '',
    '## Timeline',
    '',
    '- 2026-05-08 — Created.',
    '',
  ].join('\n');
}

describe('transitionStatus', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'transition-'));
    path = join(dir, 'README.md');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('flips the bold-prose **Status** line', async () => {
    await fs.writeFile(
      path,
      [
        '# T',
        '',
        '**Date**: 2026-05-08',
        '**Status**: now',
        '**Kind**: project',
        '**Apps**: `x`',
        '',
        '## Timeline',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await transitionStatus(path, 'review');
    const out = await fs.readFile(path, 'utf8');
    expect(result.previousStatus).toBe('now');
    expect(result.newStatus).toBe('review');
    expect(out).toContain('**Status**: review');
    expect(out).not.toContain('**Status**: now');
  });

  it('flips the YAML frontmatter status line', async () => {
    await fs.writeFile(
      path,
      [
        '---',
        'date: 2026-05-08',
        'kind: project',
        'status: now',
        'apps:',
        '  - x',
        '---',
        '',
        '# T',
        '',
        '## Timeline',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await transitionStatus(path, 'review');
    const out = await fs.readFile(path, 'utf8');
    expect(result.previousStatus).toBe('now');
    expect(result.newStatus).toBe('review');
    expect(out).toMatch(/^status: review$/m);
    expect(out).not.toMatch(/^status: now$/m);
  });

  it('preserves quoting in the YAML frontmatter status line', async () => {
    await fs.writeFile(
      path,
      ['---', 'status: "now"', 'kind: project', '---', '', '# T', '', '## Timeline', ''].join('\n'),
      'utf8',
    );
    await transitionStatus(path, 'review');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toMatch(/^status: "review"$/m);
  });

  it('appends a Closed line on done-edges in YAML form', async () => {
    await fs.writeFile(
      path,
      [
        '---',
        'date: 2026-05-08',
        'kind: project',
        'status: now',
        'apps:',
        '  - x',
        '---',
        '',
        '# T',
        '',
        '## Timeline',
        '',
        '- 2026-05-08 — Created.',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await transitionStatus(path, 'done', { today: '2026-05-09' });
    const out = await fs.readFile(path, 'utf8');
    expect(result.timelineAppended).toBe('- 2026-05-09 — Closed.');
    expect(out).toContain('- 2026-05-09 — Closed.');
  });

  it('appends a summary-annotated Closed line when opts.summary is given', async () => {
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    const result = await transitionStatus(path, 'done', {
      today: '2026-05-09',
      summary: 'Shipped as v3.14.1',
    });
    const out = await fs.readFile(path, 'utf8');
    expect(result.timelineAppended).toBe('- 2026-05-09 — Closed. Shipped as v3.14.1.');
    expect(out).toContain('- 2026-05-09 — Closed. Shipped as v3.14.1.');
  });

  it('appends a bare Reopened line on the reopen edge', async () => {
    await fs.writeFile(path, doneEdgeReadme('done'), 'utf8');
    const result = await transitionStatus(path, 'now', { today: '2026-05-10' });
    const out = await fs.readFile(path, 'utf8');
    expect(result.timelineAppended).toBe('- 2026-05-10 — Reopened.');
    expect(out).toContain('- 2026-05-10 — Reopened.');
  });

  it('appends a summary-annotated Reopened line, mirroring the close edge', async () => {
    await fs.writeFile(path, doneEdgeReadme('done'), 'utf8');
    const result = await transitionStatus(path, 'review', {
      today: '2026-05-10',
      summary: 'PR #42 reverted upstream',
    });
    const out = await fs.readFile(path, 'utf8');
    expect(result.timelineAppended).toBe('- 2026-05-10 — Reopened. PR #42 reverted upstream.');
    expect(out).toContain('- 2026-05-10 — Reopened. PR #42 reverted upstream.');
    expect(out).toMatch(/^status: review$/m);
  });

  it('trims the summary and falls back to the bare form when it is blank', async () => {
    await fs.writeFile(path, doneEdgeReadme('done'), 'utf8');
    const result = await transitionStatus(path, 'now', { today: '2026-05-10', summary: '   ' });
    expect(result.timelineAppended).toBe('- 2026-05-10 — Reopened.');
  });

  // A summary is interpolated verbatim into the timeline bullet, so an
  // embedded newline forges extra timeline entries. The worst shape is a
  // *reopen* summary carrying a `Closed.` bullet: the sweeper diffs
  // `Closed.` entries against HEAD, so the forged line makes it mint a close
  // milestone for what was a reopen.
  it('rejects a newline-bearing summary on the reopen edge and writes nothing', async () => {
    await fs.writeFile(path, doneEdgeReadme('done'), 'utf8');
    const before = await fs.readFile(path, 'utf8');
    await expect(
      transitionStatus(path, 'now', {
        today: '2026-05-10',
        summary: 'premature\n- 2026-05-10 — Closed. shipped v9',
      }),
    ).rejects.toThrow(/single line/);
    // The reject is total: status line included, the file is byte-identical.
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('keeps the sweeper from seeing a forged close after a rejected reopen', async () => {
    await fs.writeFile(path, doneEdgeReadme('done'), 'utf8');
    const head = await fs.readFile(path, 'utf8');
    await expect(
      transitionStatus(path, 'now', {
        today: '2026-05-10',
        summary: 'premature\n- 2026-05-10 — Closed. shipped v9',
      }),
    ).rejects.toThrow(/single line/);
    const worktree = await fs.readFile(path, 'utf8');
    expect(
      closeMilestoneSubject(
        '2026-05-08-t',
        extractClosedEntries(head),
        extractClosedEntries(worktree),
      ),
    ).toBeNull();
  });

  it('rejects a newline-bearing summary on the close edge too', async () => {
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    const before = await fs.readFile(path, 'utf8');
    await expect(
      transitionStatus(path, 'done', {
        today: '2026-05-09',
        summary: 'shipped\n- 2026-05-09 — Closed. and again',
      }),
    ).rejects.toThrow(/single line/);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('rejects CRLF and lone-CR summaries, not just bare LF', async () => {
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    await expect(
      transitionStatus(path, 'done', { today: '2026-05-09', summary: 'one\r\ntwo' }),
    ).rejects.toThrow(/single line/);
    await expect(
      transitionStatus(path, 'done', { today: '2026-05-09', summary: 'one\rtwo' }),
    ).rejects.toThrow(/single line/);
  });

  // U+2028 / U+2029 are ECMAScript LineTerminators too. They forge nothing —
  // every reader splits on /\r?\n/, so they never start a new physical line —
  // but they break the read path in the other direction: `.` does not cross a
  // LineTerminator, so a `Closed.` entry carrying one stops matching
  // `CLOSED_ENTRY` and `parseTimelineEntries`. The close then goes invisible.
  it('rejects U+2028 / U+2029 line separators on the close edge', async () => {
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    const before = await fs.readFile(path, 'utf8');
    await expect(
      transitionStatus(path, 'done', { today: '2026-05-09', summary: 'shipped\u2028v9' }),
    ).rejects.toThrow(/single line/);
    await expect(
      transitionStatus(path, 'done', { today: '2026-05-09', summary: 'shipped\u2029v9' }),
    ).rejects.toThrow(/single line/);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('rejects U+2028 / U+2029 line separators on the reopen edge', async () => {
    await fs.writeFile(path, doneEdgeReadme('done'), 'utf8');
    const before = await fs.readFile(path, 'utf8');
    await expect(
      transitionStatus(path, 'now', { today: '2026-05-10', summary: 'reverted\u2028upstream' }),
    ).rejects.toThrow(/single line/);
    await expect(
      transitionStatus(path, 'now', { today: '2026-05-10', summary: 'reverted\u2029upstream' }),
    ).rejects.toThrow(/single line/);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  // The damage the guard prevents, stated independently of the guard: a
  // `Closed.` entry carrying U+2028 is invisible to both readers, so the
  // sweeper would mint `<item>: sync` instead of a close milestone and
  // `backfill-closed` would later append a second `Closed.` entry.
  it('would lose a close entry that carried a line separator', async () => {
    const withSeparator = '- 2026-05-09 — Closed. shipped\u2028v9.';
    const control = '- 2026-05-09 — Closed. shipped v9.';
    expect(extractClosedEntries(withSeparator)).toEqual([]);
    expect(parseTimelineEntries(`## Timeline\n\n${withSeparator}\n`)).toEqual([]);
    expect(extractClosedEntries(control)).toEqual(['shipped v9.']);
    expect(parseTimelineEntries(`## Timeline\n\n${control}\n`)).toEqual([
      { date: '2026-05-09', text: 'Closed. shipped v9.' },
    ]);
  });

  it('keeps the sweeper from seeing an invisible close after a rejected U+2028 close', async () => {
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    const head = await fs.readFile(path, 'utf8');
    await expect(
      transitionStatus(path, 'done', { today: '2026-05-09', summary: 'shipped\u2028v9' }),
    ).rejects.toThrow(/single line/);
    const worktree = await fs.readFile(path, 'utf8');
    expect(worktree).toBe(head);
    expect(
      closeMilestoneSubject(
        '2026-05-08-t',
        extractClosedEntries(head),
        extractClosedEntries(worktree),
      ),
    ).toBeNull();
  });

  it('accepts a summary whose only line separator is stripped by the trim', async () => {
    // `trim()` strips U+2028 / U+2029 as whitespace, so a leading or trailing
    // one is not an error — only an interior break survives into the line.
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    const result = await transitionStatus(path, 'done', {
      today: '2026-05-09',
      summary: '\u2028Shipped as v3.14.1\u2029',
    });
    expect(result.timelineAppended).toBe('- 2026-05-09 — Closed. Shipped as v3.14.1.');
    expect(extractClosedEntries(await fs.readFile(path, 'utf8'))).toEqual(['Shipped as v3.14.1.']);
  });

  it('rejects a benign multi-line summary, which would otherwise read truncated', async () => {
    // No injection intent here: the flush-left continuation is simply dropped
    // by `parseTimelineEntries` (it folds only *indented* continuations), so
    // the entry would render short while the stray line stayed in the file.
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    await expect(
      transitionStatus(path, 'done', { today: '2026-05-09', summary: 'line one\nline two' }),
    ).rejects.toThrow(/single line/);
  });

  it('accepts a summary whose only newline is trailing whitespace', async () => {
    // The guard runs after the trim, so a shell-supplied trailing newline is
    // not an error — only a break that would survive into the written line.
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    const result = await transitionStatus(path, 'done', {
      today: '2026-05-09',
      summary: '\nShipped as v3.14.1\n',
    });
    expect(result.timelineAppended).toBe('- 2026-05-09 — Closed. Shipped as v3.14.1.');
  });

  it('writes no timeline entry on a non-done-edge, even with a summary', async () => {
    await fs.writeFile(path, doneEdgeReadme('now'), 'utf8');
    const result = await transitionStatus(path, 'review', {
      today: '2026-05-10',
      summary: 'ignored',
    });
    const out = await fs.readFile(path, 'utf8');
    expect(result.timelineAppended).toBeNull();
    expect(out).not.toContain('ignored');
  });

  it('handles a BOM-prefixed frontmatter file and drops the BOM on write', async () => {
    await fs.writeFile(
      path,
      '﻿' +
        ['---', 'date: 2026-05-08', 'kind: project', 'status: now', '---', '', '# T', ''].join(
          '\n',
        ),
      'utf8',
    );
    const result = await transitionStatus(path, 'review');
    const out = await fs.readFile(path, 'utf8');
    expect(result.previousStatus).toBe('now');
    expect(out).toMatch(/^status: review$/m);
    // The BOM is dropped permanently — the write normalises the file.
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('appends the Closed line to the real ## Timeline, not a fenced example', async () => {
    await fs.writeFile(
      path,
      [
        '---',
        'status: now',
        'kind: project',
        '---',
        '',
        '# T',
        '',
        '## Notes',
        '',
        'Example of a timeline section:',
        '',
        '```markdown',
        '## Timeline',
        '',
        '- 2020-01-01 — Example entry.',
        '```',
        '',
        '## Timeline',
        '',
        '- 2026-05-08 — Created.',
        '',
      ].join('\n'),
      'utf8',
    );
    await transitionStatus(path, 'done', { today: '2026-05-09' });
    const out = await fs.readFile(path, 'utf8');
    // The fenced example is untouched...
    expect(out).toContain('```markdown\n## Timeline\n\n- 2020-01-01 — Example entry.\n```');
    // ...and the Closed line landed under the real heading, after Created.
    expect(out).toContain('- 2026-05-08 — Created.\n- 2026-05-09 — Closed.');
  });

  it("doesn't pick up a status: line outside the frontmatter fence", async () => {
    await fs.writeFile(
      path,
      [
        '---',
        'date: 2026-05-08',
        'kind: project',
        'status: now',
        '---',
        '',
        '# T',
        '',
        '## Notes',
        '',
        'A line of body text mentioning status: maybe.',
        '',
      ].join('\n'),
      'utf8',
    );
    await transitionStatus(path, 'review');
    const out = await fs.readFile(path, 'utf8');
    expect(out).toContain('status: review');
    expect(out).toContain('status: maybe.');
  });
});

describe('parseTimelineEntries continuation folding', () => {
  it('folds indented wrapped lines into the entry and stops at the next heading', () => {
    const raw = [
      '# T',
      '',
      '## Timeline',
      '',
      '- 2026-06-01 — First line wraps',
      '  onto a second line; mentions #42 and v1.2.3.',
      '- 2026-06-02 — Standalone.',
      '',
      '## Notes',
      '- not a timeline entry',
    ].join('\n');
    const entries = parseTimelineEntries(raw);
    expect(entries).toEqual([
      { date: '2026-06-01', text: 'First line wraps onto a second line; mentions #42 and v1.2.3.' },
      { date: '2026-06-02', text: 'Standalone.' },
    ]);
  });
});

describe('parseTimelineEntries fence handling', () => {
  it('ignores dated bullets inside fenced code blocks', () => {
    const raw = [
      '# T',
      '',
      '## Timeline',
      '',
      '- 2026-06-01 — Real entry.',
      '',
      '```',
      '- 2026-06-02 — Fenced, not a timeline entry.',
      '```',
      '',
      '- 2026-06-03 — Another real entry.',
      '',
    ].join('\n');
    const entries = parseTimelineEntries(raw);
    expect(entries).toEqual([
      { date: '2026-06-01', text: 'Real entry.' },
      { date: '2026-06-03', text: 'Another real entry.' },
    ]);
  });
});

describe('parseTimelineEntries ↔ CLOSED_LINE agreement', () => {
  it('the close lines parseTimelineEntries yields all match CLOSED_LINE', () => {
    // Every close that `condash projects close --summary` writes should be
    // both a valid timeline entry AND match the close-detection regex used
    // by extractClosedAt. If these two regexes drift apart, an old close
    // appears in the timeline but extractClosedAt reports `closedAt: null`.
    const raw = [
      '# T',
      '',
      '## Timeline',
      '',
      '- 2026-05-19 — Closed.',
      '- 2026-05-15 — Closed. Shipped as v3.14.1.',
      '- 2026-05-14 — Reopened.',
      '- 2026-05-13 — Closed. Shipped in v3.13.0.',
      '',
    ].join('\n');
    const entries = parseTimelineEntries(raw);
    const closeEntries = entries.filter((e) => /^Closed/.test(e.text));
    expect(closeEntries).toHaveLength(3);
    for (const e of closeEntries) {
      const line = `- ${e.date} — ${e.text}`;
      expect(line).toMatch(CLOSED_LINE);
    }
  });
});
