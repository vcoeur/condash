import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { activityCommand } from './projects-activity';
import {
  makeTmpConception,
  rmConception,
  writeProjectReadme,
  captureStdout,
  jsonCtx,
  humanCtx,
  parseJsonEnvelope,
} from './test-helpers';

interface ActivityData {
  meta: { begin: string; end: string; itemCount: number; eventCount: number };
  items: {
    slug: string;
    apps: string[];
    prNums: string[];
    versions: string[];
    createdInRange: boolean;
    closedInRange: boolean;
    closedAt: string | null;
    eventCount: number;
  }[];
  events: { date: string; isoWeek: string; month: string; slug: string; bookkeeping: boolean }[];
  index: { days: string[]; weeks: string[]; months: string[]; apps: Record<string, string[]> };
}

const RANGE = { begin: '2026-06-01', end: '2026-06-07' };

async function seed(conceptionPath: string): Promise<void> {
  // alpha: real work in range; apps carry a dup (#condash + condash) to exercise
  // normalization; a PR + version in the text.
  await writeProjectReadme(conceptionPath, 'alpha', {
    date: '2026-06-02',
    kind: 'project',
    status: 'done',
    apps: ['"#condash"', 'condash'], // quoted #-handle + bare → both canonicalize to #condash
    body: '## Timeline\n\n- 2026-06-02 — Project created.\n- 2026-06-03 — Shipped the thing. Opened PR #42; tagged v1.2.3.\n',
  });
  // beta: only a bookkeeping re-stamp falls in range → must be excluded.
  await writeProjectReadme(conceptionPath, 'beta', {
    date: '2026-05-20',
    kind: 'project',
    status: 'done',
    apps: ['agedum'],
    body: '## Timeline\n\n- 2026-05-20 — Project created.\n- 2026-06-04 — Checked knowledge promotion\n',
  });
  // gamma: created in range, no timeline events, no apps → included via creation,
  // grouped under #unscoped.
  await writeProjectReadme(conceptionPath, 'gamma', {
    date: '2026-06-05',
    kind: 'incident',
    status: 'now',
  });
  // delta: created out of range, closed in range → included via close.
  await writeProjectReadme(conceptionPath, 'delta', {
    date: '2026-04-01',
    kind: 'project',
    status: 'done',
    apps: ['knoten'],
    body: '## Timeline\n\n- 2026-04-01 — Project created.\n- 2026-06-06 — Closed. Shipped it.\n',
  });
}

describe('projects activity', () => {
  let conceptionPath: string;
  beforeEach(async () => {
    conceptionPath = await makeTmpConception();
    await seed(conceptionPath);
  });
  afterEach(async () => {
    await rmConception(conceptionPath);
  });

  it('includes substantive / created / closed items and excludes bookkeeping-only', async () => {
    const { stdout } = await captureStdout(() =>
      activityCommand(
        { noun: 'projects', verb: 'activity', positional: [], flags: { ...RANGE } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const { ok, data } = parseJsonEnvelope<ActivityData>(stdout);
    expect(ok).toBe(true);
    const slugs = data!.items.map((i) => i.slug).sort();
    expect(slugs).toEqual(['2026-06-02-alpha', '2026-06-05-gamma', '2026-04-01-delta'].sort());
    expect(slugs).not.toContain('2026-05-20-beta');
    expect(data!.meta.itemCount).toBe(3);
  });

  it('normalizes apps, mines PR/version refs, and tags iso week + month', async () => {
    const { stdout } = await captureStdout(() =>
      activityCommand(
        { noun: 'projects', verb: 'activity', positional: [], flags: { ...RANGE } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const { data } = parseJsonEnvelope<ActivityData>(stdout);
    const alpha = data!.items.find((i) => i.slug === '2026-06-02-alpha')!;
    expect(alpha.apps).toEqual(['#condash']); // dup collapsed, single handle
    expect(alpha.prNums).toEqual(['42']);
    expect(alpha.versions).toEqual(['v1.2.3']);
    expect(alpha.eventCount).toBe(2);

    const shipped = data!.events.find((e) => e.date === '2026-06-03')!;
    expect(shipped.isoWeek).toBe('2026-W23');
    expect(shipped.month).toBe('2026-06');
    expect(shipped.bookkeeping).toBe(false);

    expect(data!.index.apps['#unscoped']).toContain('2026-06-05-gamma');
    expect(data!.index.days).toContain('2026-06-03');
    expect(data!.index.days).not.toContain('2026-06-04'); // beta excluded
  });

  it('marks created-in-range and closed-in-range membership', async () => {
    const { stdout } = await captureStdout(() =>
      activityCommand(
        { noun: 'projects', verb: 'activity', positional: [], flags: { ...RANGE } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const { data } = parseJsonEnvelope<ActivityData>(stdout);
    const gamma = data!.items.find((i) => i.slug === '2026-06-05-gamma')!;
    expect(gamma.createdInRange).toBe(true);
    expect(gamma.eventCount).toBe(0);
    const delta = data!.items.find((i) => i.slug === '2026-04-01-delta')!;
    expect(delta.closedInRange).toBe(true);
    expect(delta.closedAt).toBe('2026-06-06');
  });

  it('--format md emits a per-day digest with refs', async () => {
    const { stdout } = await captureStdout(() =>
      activityCommand(
        { noun: 'projects', verb: 'activity', positional: [], flags: { ...RANGE, format: 'md' } },
        humanCtx(),
        conceptionPath,
      ),
    );
    expect(stdout).toContain('## Per day');
    expect(stdout).toContain('### 2026-06-03');
    expect(stdout).toContain('(#42, v1.2.3)');
    expect(stdout).toContain('**By app:**');
  });
});
