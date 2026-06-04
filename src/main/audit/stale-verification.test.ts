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

    const result = await scanStaleStamps(conceptionPath, 30, today);
    expect(result.stale.map((s) => s.relPath)).toEqual(['knowledge/topics/stale.md']);
    expect(result.fresh.map((f) => f.relPath)).toEqual(['knowledge/topics/fresh.md']);
    expect(result.unstamped).toEqual(['knowledge/topics/none.md']);
    expect(result.maxAgeDays).toBe(30);
    expect(result.stale[0].ageDays).toBeGreaterThan(30);
  });

  it('excludes auto-generated index.md from the scan', async () => {
    // An unstamped index.md must NOT show up as unstamped — it's generated.
    await writeKnowledge('index.md', '# knowledge\n\n- [a](topics/)\n');
    await writeKnowledge('topics/index.md', '# topics\n');
    await writeKnowledge('topics/a.md', '# A\n\n**Verified:** 2026-01-20 x\n');

    const result = await scanStaleStamps(conceptionPath, 30, new Date('2026-02-01T00:00:00Z'));
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
    const result = await scanStaleStamps(conceptionPath, 30, new Date('2026-02-01T00:00:00Z'));
    const issues = staleStampsToIssues(result, 'stale_verification');
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('stale_verification');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].fix.autoFix).toBe(false);
    expect(issues[0].file).toBe('knowledge/topics/stale.md');
  });

  it('defaults the check label to the canonical hyphenated audit name', async () => {
    await writeKnowledge('topics/stale.md', '# Stale\n\n**Verified:** 2020-01-01 x\n');
    const result = await scanStaleStamps(conceptionPath, 30, new Date('2026-02-01T00:00:00Z'));
    expect(staleStampsToIssues(result)[0].check).toBe('stale-verification');
  });
});

describe('checkStaleVerification', () => {
  it('returns only stale issues at the default threshold', async () => {
    // A 1-day-old stamp is fresh against the 30-day default → no issue.
    const recent = new Date();
    recent.setUTCDate(recent.getUTCDate() - 1);
    const recentIso = recent.toISOString().slice(0, 10);
    await writeKnowledge('topics/fresh.md', `# Fresh\n\n**Verified:** ${recentIso} x\n`);
    await writeKnowledge('topics/ancient.md', '# Ancient\n\n**Verified:** 2000-01-01 x\n');

    const issues = await checkStaleVerification(conceptionPath);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('stale-verification');
    expect(issues[0].file).toBe('knowledge/topics/ancient.md');
  });
});
