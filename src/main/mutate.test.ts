import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addStep, CLOSED_LINE, parseTimelineEntries, transitionStatus } from './mutate';

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
