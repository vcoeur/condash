import { relative } from 'node:path';
import { toPosix } from '../../shared/path';
import { findProjectReadmes } from '../../main/walk';
import { parseReadmeWithHeader } from '../../main/parse';
import { appPillText } from '../../shared/app-color';
import { emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { NOUN_FLAGS } from './projects';

/** One dated `## Timeline` beat, decorated with its item's identity + any PR /
 *  version references mined from the text. */
interface ActivityEvent {
  date: string;
  isoWeek: string;
  month: string;
  slug: string;
  title: string;
  apps: string[];
  kind: string;
  status: string;
  text: string;
  prNums: string[];
  versions: string[];
  /** True for routine bookkeeping beats (created / closed / re-check / worktree /
   *  status flip) so consumers can de-emphasise them. */
  bookkeeping: boolean;
}

/** One project that saw substantive activity in the range. */
interface ActivityItem {
  slug: string;
  title: string;
  kind: string;
  status: string;
  apps: string[];
  branch: string | null;
  date: string | null;
  closedAt: string | null;
  path: string;
  stepCounts: { todo: number; doing: number; done: number; blocked: number; dropped: number };
  createdInRange: boolean;
  closedInRange: boolean;
  prNums: string[];
  versions: string[];
  eventCount: number;
}

interface ActivityDataset {
  meta: {
    begin: string;
    end: string;
    generated: string;
    conception: string;
    itemCount: number;
    eventCount: number;
  };
  items: ActivityItem[];
  events: ActivityEvent[];
  index: {
    days: string[];
    weeks: string[];
    months: string[];
    apps: Record<string, string[]>;
  };
}

const PR_RE = /#(\d+)/g;
const VERSION_RE = /v\d+\.\d+\.\d+/g;
// Routine bookkeeping beats — not "work done", so membership ignores them and
// renderers de-emphasise them. Matches the conception extractor's set.
const BOOKKEEPING_RE =
  /^(Project created|Incident created|Document created|Created|Closed|Checked knowledge promotion|Worktree set up|Status →)/;

/** ISO-8601 week label (e.g. `2026-W23`) for a `YYYY-MM-DD` date. */
function isoWeek(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  // Shift to the Thursday of this ISO week, then count weeks from the year's
  // first Thursday. The Thursday's calendar year is the ISO week-year.
  const dayMonZero = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayMonZero + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayMonZero = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayMonZero + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Canonicalise an item's `apps[]` to deduped `#handle` form. condash's project
 *  parser returns apps exactly as written (mixed `#handle` / bare / path), so a
 *  consumer that groups by app must normalise; `#unscoped` when the item has
 *  none. */
function normalizeApps(apps: readonly string[]): string[] {
  const seen: string[] = [];
  for (const ref of apps) {
    const handle = appPillText(ref);
    if (handle !== '#' && !seen.includes(handle)) seen.push(handle);
  }
  return seen.length ? seen : ['#unscoped'];
}

/** All PR numbers + version tags referenced in a timeline line. */
function extractRefs(text: string): { prNums: string[]; versions: string[] } {
  return {
    prNums: [...text.matchAll(PR_RE)].map((m) => m[1]),
    versions: text.match(VERSION_RE) ?? [],
  };
}

function addDays(date: string, delta: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Build the activity dataset for the inclusive range [begin, end]. */
async function buildActivity(
  conceptionPath: string,
  begin: string,
  end: string,
): Promise<ActivityDataset> {
  const readmes = await findProjectReadmes(conceptionPath);
  const items: ActivityItem[] = [];
  const events: ActivityEvent[] = [];

  for (const readme of readmes) {
    const { project, header } = await parseReadmeWithHeader(readme);
    const inRange = project.timeline.filter((entry) => entry.date >= begin && entry.date <= end);
    const meaningful = inRange.filter((entry) => !BOOKKEEPING_RE.test(entry.text));
    const date = header.date;
    const createdInRange = date !== null && date >= begin && date <= end;
    const closedAt = project.closedAt;
    const closedInRange = closedAt !== null && closedAt >= begin && closedAt <= end;
    // A bookkeeping-only re-stamp on an old item is not work done in the range.
    if (meaningful.length === 0 && !createdInRange && !closedInRange) continue;

    const apps = normalizeApps(project.apps);
    const itemPrs = new Set<string>();
    const itemVersions = new Set<string>();
    for (const entry of inRange) {
      const { prNums, versions } = extractRefs(entry.text);
      prNums.forEach((n) => itemPrs.add(n));
      versions.forEach((v) => itemVersions.add(v));
      events.push({
        date: entry.date,
        isoWeek: isoWeek(entry.date),
        month: entry.date.slice(0, 7),
        slug: project.slug,
        title: project.title,
        apps,
        kind: project.kind,
        status: project.status,
        text: entry.text,
        prNums,
        versions,
        bookkeeping: BOOKKEEPING_RE.test(entry.text),
      });
    }

    const itemDir = readme.replace(/\/README\.md$/, '');
    items.push({
      slug: project.slug,
      title: project.title,
      kind: project.kind,
      status: project.status,
      apps,
      branch: project.branch,
      date,
      closedAt,
      path: toPosix(relative(conceptionPath, itemDir)),
      stepCounts: project.stepCounts,
      createdInRange,
      closedInRange,
      prNums: [...itemPrs].sort((a, b) => Number(a) - Number(b)),
      versions: [...itemVersions].sort(),
      eventCount: inRange.length,
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug));
  const appsIndex: Record<string, string[]> = {};
  for (const item of items) {
    for (const app of item.apps) (appsIndex[app] ??= []).push(item.slug);
  }

  return {
    meta: {
      begin,
      end,
      generated: new Date().toISOString(),
      conception: conceptionPath,
      itemCount: items.length,
      eventCount: events.length,
    },
    items,
    events,
    index: {
      days: [...new Set(events.map((e) => e.date))].sort(),
      weeks: [...new Set(events.map((e) => e.isoWeek))].sort(),
      months: [...new Set(events.map((e) => e.month))].sort(),
      apps: appsIndex,
    },
  };
}

/**
 * `condash projects activity` — generic project-tree activity data.
 *
 * Parses every project README's `## Timeline` over a date range and emits
 * structured activity (items + dated events + day/week/month/app indices). It is
 * the reusable data layer the work-digest task and any other consumer build on;
 * the rich/customisable rendering stays with the consumer.
 */
export async function activityCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const beginFlag = typeof args.flags.begin === 'string' ? args.flags.begin : null;
  const endFlag = typeof args.flags.end === 'string' ? args.flags.end : null;
  const format = typeof args.flags.format === 'string' ? args.flags.format : null;
  for (const k of ['begin', 'end', 'format']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);

  const end = endFlag ?? new Date().toISOString().slice(0, 10);
  const begin = beginFlag ?? addDays(end, -6);

  const dataset = await buildActivity(conceptionPath, begin, end);
  emit(ctx, dataset, format === 'md' ? formatActivityMarkdown : formatActivitySummary);
}

/** Default human output — a compact one-look summary. */
function formatActivitySummary(data: ActivityDataset): string {
  const { meta, index } = data;
  const lines = [
    `Activity ${meta.begin} … ${meta.end}: ${meta.itemCount} items, ${meta.eventCount} events across ${index.days.length} day(s) [${index.weeks.join(', ')}]`,
    `By app:  ${facet(data, 'apps')}`,
    `By kind: ${facet(data, 'kind')}`,
  ];
  return lines.join('\n') + '\n';
}

/** No-frills markdown convenience — per-day item bullets + facet footer. The
 *  rich, customisable render lives with the consumer. */
function formatActivityMarkdown(data: ActivityDataset): string {
  const { meta, index } = data;
  const lines = [
    `# Activity — ${meta.begin} … ${meta.end}`,
    `${meta.itemCount} items · ${meta.eventCount} events · ${index.weeks.join(', ')}`,
    '',
    '## Per day',
  ];
  for (const day of index.days) {
    const dayEvents = data.events.filter((e) => e.date === day);
    const prs = new Set(dayEvents.flatMap((e) => e.prNums));
    const versions = new Set(dayEvents.flatMap((e) => e.versions));
    const closed = data.items.filter((i) => i.closedAt === day).length;
    lines.push('', `### ${day} · ${closed} closed · ${prs.size} PRs · ${versions.size} releases`);
    const bySlug = new Map<string, ActivityEvent[]>();
    for (const e of dayEvents) {
      const arr = bySlug.get(e.slug);
      if (arr) arr.push(e);
      else bySlug.set(e.slug, [e]);
    }
    for (const [, slugEvents] of bySlug) {
      const first = slugEvents[0];
      const meaningful = slugEvents.filter((e) => !e.bookkeeping).map((e) => e.text);
      const text = (meaningful.length ? meaningful : slugEvents.map((e) => e.text)).join(' ');
      const refs = [
        ...new Set(slugEvents.flatMap((e) => e.prNums.map((n) => `#${n}`))),
        ...new Set(slugEvents.flatMap((e) => e.versions)),
      ];
      const suffix = refs.length ? ` (${refs.join(', ')})` : '';
      lines.push(
        `- **${first.apps.join(' ')}** ${first.title} — ${text} \`[${first.kind} · ${first.status}]\`${suffix}`,
      );
    }
  }
  lines.push('', `**By app:** ${facet(data, 'apps')}`, `**By kind:** ${facet(data, 'kind')}`);
  return lines.join('\n') + '\n';
}

/** Render a faceted count line: `#condash 23 · #agedum 24` or `project 49`. */
function facet(data: ActivityDataset, field: 'apps' | 'kind'): string {
  const counts = new Map<string, number>();
  for (const item of data.items) {
    const values = field === 'apps' ? item.apps : [item.kind];
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value} ${count}`)
    .join(' · ');
}
