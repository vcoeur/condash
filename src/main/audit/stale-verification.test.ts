/**
 * Tests for the `stale-verification` audit check engine — the scan that
 * backs both `condash audit --include stale-verification` and the
 * `condash knowledge verify` command.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkStaleVerification, scanStaleStamps, staleStampsToIssues } from './stale-verification';

let conceptionPath: string;

async function writeKnowledge(relPath: string, content: string): Promise<void> {
  const full = join(conceptionPath, 'knowledge', relPath);
  await fs.mkdir(dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

beforeEach(async () => {
  conceptionPath = await fs.mkdtemp(join(tmpdir(), 'condash-stale-verif-'));
  await fs.mkdir(join(conceptionPath, 'knowledge'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(conceptionPath, { recursive: true, force: true });
});

describe('scanStaleStamps', () => {
  it('classifies stamps as stale / fresh / unstamped', async () => {
    const today = new Date('2026-02-01T00:00:00Z');
    await writeKnowledge('topics/stale.md', '# Stale\n\n**Verified:** 2025-01-01 old@deadbeef\n');
    await writeKnowledge('topics/fresh.md', '# Fresh\n\n**Verified:** 2026-01-20 new@cafef00d\n');
    await writeKnowledge('topics/none.md', '# None\n\nNo stamp.\n');

    const result = await scanStaleStamps(conceptionPath, 90, today);
    expect(result.stale.map((s) => s.relPath)).toEqual(['knowledge/topics/stale.md']);
    expect(result.fresh.map((f) => f.relPath)).toEqual(['knowledge/topics/fresh.md']);
    expect(result.unstamped).toEqual(['knowledge/topics/none.md']);
    expect(result.maxAgeDays).toBe(90);
    expect(result.stale[0].ageDays).toBeGreaterThan(90);
  });

  it('defaults to the 90-day freshness window', async () => {
    // A 60-day-old stamp is stale against the old 30-day window but fresh
    // against the 90-day default — pins the default, not just a parameter.
    await writeKnowledge('topics/sixty.md', '# Sixty\n\n**Verified:** 2025-12-03 x\n');
    const result = await scanStaleStamps(
      conceptionPath,
      undefined,
      new Date('2026-02-01T00:00:00Z'),
    );
    expect(result.maxAgeDays).toBe(90);
    expect(result.stale).toEqual([]);
    expect(result.fresh.map((f) => f.relPath)).toEqual(['knowledge/topics/sixty.md']);
  });

  it('judges a multi-stamp file on its oldest stamp, both directions', async () => {
    const today = new Date('2026-08-18T00:00:00Z');
    // Header fresh, section old — used to read as fresh, hiding the old claim.
    await writeKnowledge(
      'topics/fresh-head.md',
      '# Fresh head\n\n**Verified:** 2026-08-14 head\n\n## Old bit\n\n**Verified:** 2026-01-02 deep\n',
    );
    // Header old, section fresh — used to read as stale on the header date
    // alone, with no sign that anything in the file was recent.
    await writeKnowledge(
      'topics/stale-head.md',
      '# Stale head\n\n**Verified:** 2026-05-04 head\n\n## New bit\n\n**Verified:** 2026-08-14 deep\n',
    );

    const result = await scanStaleStamps(conceptionPath, 90, today);
    expect(result.fresh).toEqual([]);
    expect(result.stale.map((s) => s.relPath).sort()).toEqual([
      'knowledge/topics/fresh-head.md',
      'knowledge/topics/stale-head.md',
    ]);

    const freshHead = result.stale.find((s) => s.relPath.endsWith('fresh-head.md'))!;
    expect(freshHead).toMatchObject({ verifiedAt: '2026-01-02', line: 7, stampCount: 2 });
    expect(freshHead.newest).toMatchObject({ verifiedAt: '2026-08-14', line: 3, ageDays: 4 });

    const staleHead = result.stale.find((s) => s.relPath.endsWith('stale-head.md'))!;
    expect(staleHead).toMatchObject({ verifiedAt: '2026-05-04', line: 3, stampCount: 2 });
    expect(staleHead.newest).toMatchObject({ verifiedAt: '2026-08-14', line: 7, ageDays: 4 });
  });

  it('reports a single-stamp file with newest equal to oldest', async () => {
    await writeKnowledge('topics/one.md', '# One\n\n**Verified:** 2026-01-20 x\n');
    const result = await scanStaleStamps(conceptionPath, 90, new Date('2026-02-01T00:00:00Z'));
    const entry = result.fresh[0];
    expect(entry.stampCount).toBe(1);
    expect(entry.newest).toMatchObject({ verifiedAt: entry.verifiedAt, line: entry.line });
  });

  it('excludes auto-generated index.md from the scan', async () => {
    // An unstamped index.md must NOT show up as unstamped — it's generated.
    await writeKnowledge('index.md', '# knowledge\n\n- [a](topics/)\n');
    await writeKnowledge('topics/index.md', '# topics\n');
    await writeKnowledge('topics/a.md', '# A\n\n**Verified:** 2026-01-20 x\n');

    const result = await scanStaleStamps(conceptionPath, 90, new Date('2026-02-01T00:00:00Z'));
    const allPaths = [
      ...result.stale.map((s) => s.relPath),
      ...result.fresh.map((f) => f.relPath),
      ...result.unstamped,
    ];
    expect(allPaths.some((p) => p.endsWith('index.md'))).toBe(false);
    expect(result.fresh.map((f) => f.relPath)).toEqual(['knowledge/topics/a.md']);
  });
});

describe('staleStampsToIssues', () => {
  it('emits warn issues that are never auto-fixed, with the given check label', async () => {
    await writeKnowledge('topics/stale.md', '# Stale\n\n**Verified:** 2020-01-01 old@deadbeef\n');
    const result = await scanStaleStamps(conceptionPath, 90, new Date('2026-02-01T00:00:00Z'));
    const issues = staleStampsToIssues(result, 'stale_verification');
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('stale_verification');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].fix.autoFix).toBe(false);
    expect(issues[0].file).toBe('knowledge/topics/stale.md');
  });

  it('names the newest stamp in the message of a multi-stamp file', async () => {
    await writeKnowledge(
      'topics/sectioned.md',
      '# Sectioned\n\n**Verified:** 2020-01-01 old\n\n## Recent\n\n**Verified:** 2026-01-30 new\n',
    );
    const result = await scanStaleStamps(conceptionPath, 90, new Date('2026-02-01T00:00:00Z'));
    const issue = staleStampsToIssues(result)[0];
    expect(issue.message).toContain('2020-01-01');
    expect(issue.message).toContain('newest of 2 stamps: 2026-01-30 (line 7)');
    expect(issue.fix.newestVerifiedAt).toBe('2026-01-30');
    expect(issue.fix.stampCount).toBe(2);
  });

  it('leaves the message unadorned for a single-stamp file', async () => {
    await writeKnowledge('topics/one.md', '# One\n\n**Verified:** 2020-01-01 x\n');
    const result = await scanStaleStamps(conceptionPath, 90, new Date('2026-02-01T00:00:00Z'));
    expect(staleStampsToIssues(result)[0].message).not.toContain('newest of');
  });

  it('defaults the check label to the canonical hyphenated audit name', async () => {
    await writeKnowledge('topics/stale.md', '# Stale\n\n**Verified:** 2020-01-01 x\n');
    const result = await scanStaleStamps(conceptionPath, 90, new Date('2026-02-01T00:00:00Z'));
    expect(staleStampsToIssues(result)[0].check).toBe('stale-verification');
  });
});

describe('checkStaleVerification', () => {
  it('returns only stale issues at the default threshold', async () => {
    // A 60-day-old stamp is stale against 30 days but fresh against the
    // 90-day default → no issue at the default threshold.
    const recent = new Date();
    recent.setUTCDate(recent.getUTCDate() - 60);
    const recentIso = recent.toISOString().slice(0, 10);
    await writeKnowledge('topics/fresh.md', `# Fresh\n\n**Verified:** ${recentIso} x\n`);
    await writeKnowledge('topics/ancient.md', '# Ancient\n\n**Verified:** 2000-01-01 x\n');

    const issues = await checkStaleVerification(conceptionPath);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('stale-verification');
    expect(issues[0].file).toBe('knowledge/topics/ancient.md');
  });
});
