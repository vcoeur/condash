import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { Deliverable, ItemKind, Project, Step, StepMarker } from '../shared/types';
import {
  HEADING2,
  CLOSED_LINE,
  iterUnfencedLines,
  parseHeader,
  type HeaderFields,
} from '../shared/header';
import { countSteps } from '../shared/projects';
import { toPosix } from '../shared/path';
import { parseTimelineEntries } from './mutate';

const STEP_LINE = /^\s*-\s\[([ ~x!-])\]\s+(.*)$/;
// `- [label](target) — optional description`. `target` is any link: a local
// file of any extension (resolved relative to the project dir) or an http(s)
// URL (kept verbatim). `mailto:` and in-page `#anchor` targets are filtered in
// extractDeliverables. Broadened from PDF-only so md / html / image / URL
// deliverables surface in the Outputs pane.
const DELIVERABLE_LINE = /^\s*-\s\[([^\]]+)\]\(([^)]+)\)(?:\s*[—\-:]\s*(.*))?\s*$/i;
const DELIVERABLE_URL = /^https?:\/\//i;
const DELIVERABLE_SKIP = /^(mailto:|#)/i;
// `- [[slug]] — comment` or `- [[slug|label]] — comment`: a wikilink to another
// conception item, with an optional trailing comment. Checked before the
// markdown-link form (which can't match `[[…]]` anyway).
const DELIVERABLE_WIKILINK = /^\s*-\s\[\[([^\]|]+)(?:\|([^\]]+))?\]\](?:\s*[—\-:]\s*(.*))?\s*$/;
const SUMMARY_MAX = 300;

export async function parseReadme(path: string): Promise<Project> {
  const raw = await fs.readFile(path, 'utf8');
  return parseReadmeFromRaw(raw, path);
}

/**
 * Same as {@link parseReadme} but returns the parsed header alongside the
 * project shape — used by CLI handlers that need `date`, `base`, `extra`,
 * or per-field warnings without re-reading and re-parsing the README. */
export async function parseReadmeWithHeader(
  path: string,
): Promise<{ project: Project; header: HeaderFields; raw: string }> {
  const raw = await fs.readFile(path, 'utf8');
  const header = parseHeader(raw);
  const project = parseReadmeFromRaw(raw, path, header);
  return { project, header, raw };
}

function parseReadmeFromRaw(raw: string, path: string, preparsedHeader?: HeaderFields): Project {
  const lines = raw.split(/\r?\n/);

  const header = preparsedHeader ?? parseHeader(raw);
  const summary = extractSummary(lines);
  const steps = extractSteps(lines);
  const stepCounts = countSteps(steps);
  const deliverables = extractDeliverables(lines, dirname(path));
  const closedAt = extractClosedAt(lines);
  const timeline = parseTimelineEntries(raw);
  // Precompute the most-recent timeline date so the list projection can drop
  // the full `timeline[]` yet still drive the card's last-activity label (G1).
  let lastActivity: string | null = null;
  for (const entry of timeline) {
    if (lastActivity === null || entry.date > lastActivity) lastActivity = entry.date;
  }

  const slug = basename(dirname(path));

  return {
    slug,
    path: toPosix(path),
    title: header.title ?? slug,
    kind: normaliseKind(header.kind),
    status: (header.status ?? 'backlog').toLowerCase(),
    apps: header.apps,
    branch: header.branch,
    base: header.base,
    summary,
    steps,
    stepCounts,
    deliverables,
    deliverableCount: deliverables.length,
    closedAt,
    timeline,
    lastActivity,
  };
}

/* Last close date from `## Timeline`, or null when the section is missing or
 * carries no Closed line. Scans the section bottom-up so a reopened project
 * (Closed → reopened → Closed again) yields the most recent date. Fence-aware:
 * a `## Timeline` heading inside a fenced code block doesn't open the
 * section, and a `- YYYY-MM-DD — Closed.` line inside one doesn't count. */
function extractClosedAt(lines: readonly string[]): string | null {
  let timelineStart = -1;
  let timelineEnd = lines.length;
  for (const { index: i, line } of iterUnfencedLines(lines)) {
    const heading = line.match(HEADING2);
    if (!heading) continue;
    if (heading[1].trim().toLowerCase() === 'timeline') {
      timelineStart = i + 1;
    } else if (timelineStart !== -1) {
      timelineEnd = i;
      break;
    }
  }
  if (timelineStart === -1) return null;
  // Re-collect unfenced indices inside the timeline window so we skip fenced
  // bullet lines on the bottom-up walk too.
  const unfencedInWindow: number[] = [];
  for (const { index: i } of iterUnfencedLines(lines)) {
    if (i >= timelineStart && i < timelineEnd) unfencedInWindow.push(i);
  }
  for (let k = unfencedInWindow.length - 1; k >= 0; k--) {
    const m = lines[unfencedInWindow[k]].match(CLOSED_LINE);
    if (m) return m[1];
  }
  return null;
}

function extractSummary(lines: readonly string[]): string | undefined {
  let inFirstSection = false;
  let buffer: string[] = [];

  // Fence-aware (like extractSteps / extractClosedAt): a `## Heading` or prose
  // inside a fenced code block must not truncate or pollute the summary.
  for (const { line } of iterUnfencedLines(lines)) {
    if (HEADING2.test(line)) {
      if (inFirstSection && buffer.length > 0) break;
      inFirstSection = true;
      buffer = [];
      continue;
    }
    if (!inFirstSection) continue;

    const trimmed = line.trim();
    if (!trimmed) {
      if (buffer.length > 0) break;
      continue;
    }
    buffer.push(trimmed);
  }

  if (buffer.length === 0) return undefined;
  const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_MAX) return text;
  return text.slice(0, SUMMARY_MAX - 1).trimEnd() + '…';
}

function extractSteps(lines: readonly string[]): Step[] {
  const out: Step[] = [];
  let section = '';

  for (const { index: i, line } of iterUnfencedLines(lines)) {
    const heading = line.match(HEADING2);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const match = line.match(STEP_LINE);
    if (!match) continue;
    out.push({
      lineIndex: i,
      marker: match[1] as StepMarker,
      text: match[2].trim(),
      section,
    });
  }
  return out;
}

function extractDeliverables(lines: readonly string[], itemDir: string): Deliverable[] {
  let inDeliverables = false;
  const out: Deliverable[] = [];

  // Fence-aware: a fenced `- [label](file.pdf)` line must not become a ghost
  // deliverable, and a fenced `## Heading` must not open/close the section.
  for (const { line } of iterUnfencedLines(lines)) {
    const heading = line.match(HEADING2);
    if (heading) {
      inDeliverables = heading[1].trim().toLowerCase().startsWith('deliverable');
      continue;
    }
    if (!inDeliverables) continue;

    // Wikilink form first: `- [[slug]]` / `- [[slug|label]]`, optional comment.
    const wiki = line.match(DELIVERABLE_WIKILINK);
    if (wiki) {
      const [, slug, wikiLabel, wikiDesc] = wiki;
      out.push({
        label: (wikiLabel ?? slug).trim(),
        path: slug.trim(),
        kind: 'wikilink',
        description: wikiDesc?.trim() || undefined,
      });
      continue;
    }

    const match = line.match(DELIVERABLE_LINE);
    if (!match) continue;
    const [, label, rawPath, description] = match;
    const target = rawPath.trim();
    // mailto: and in-page anchors are navigation, not deliverables.
    if (DELIVERABLE_SKIP.test(target)) continue;
    // URLs are kept verbatim; local links resolve against the project dir.
    const isUrl = DELIVERABLE_URL.test(target);
    const value = isUrl ? target : toPosix(isAbsolute(target) ? target : resolve(itemDir, target));
    out.push({
      label: label.trim(),
      path: value,
      kind: isUrl ? 'url' : 'file',
      description: description?.trim() || undefined,
    });
  }
  return out;
}

function normaliseKind(value: string | null): ItemKind {
  switch ((value ?? '').toLowerCase()) {
    case 'project':
      return 'project';
    case 'incident':
      return 'incident';
    case 'document':
      return 'document';
    default:
      return 'unknown';
  }
}
