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
