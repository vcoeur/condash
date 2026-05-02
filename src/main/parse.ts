import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { Deliverable, ItemKind, Project, Step, StepMarker } from '../shared/types';
import { HEADING2, parseHeader } from '../shared/header';
import { countSteps } from '../shared/projects';
import { toPosix } from '../shared/path';
import { parseTimelineEntries } from './mutate';

const STEP_LINE = /^\s*-\s\[([ ~x-])\]\s+(.*)$/;
const DELIVERABLE_LINE = /^\s*-\s\[([^\]]+)\]\(([^)]+\.pdf)\)(?:\s*[—\-:]\s*(.*))?\s*$/i;
const SUMMARY_MAX = 300;
/** Matches a Timeline list item recording a close, e.g.
 *    - 2026-05-02 — Closed.
 *    - 2026-05-02 — Closed. Shipped in v2.9.4.
 * Used by extractClosedAt to find the latest close date. The trailing class
 * tolerates the bare form, an end-of-line, or a space (allowing the optional
 * summary that condash projects close --summary writes). */
const CLOSED_LINE = /^\s*-\s+(\d{4}-\d{2}-\d{2})\s+—\s+Closed(\.|$|\s)/;

export async function parseReadme(path: string): Promise<Project> {
  const raw = await fs.readFile(path, 'utf8');
  const lines = raw.split(/\r?\n/);

  const header = parseHeader(raw);
  const summary = extractSummary(lines);
  const steps = extractSteps(lines);
  const stepCounts = countSteps(steps);
  const deliverables = extractDeliverables(lines, dirname(path));
  const closedAt = extractClosedAt(lines);
  const timeline = parseTimelineEntries(raw);

  const slug = basename(dirname(path));

  return {
    slug,
    path: toPosix(path),
    title: header.title ?? slug,
    kind: normaliseKind(header.kind),
    status: (header.status ?? 'backlog').toLowerCase(),
    apps: header.apps,
    branch: header.branch,
    summary,
    steps,
    stepCounts,
    deliverables,
    deliverableCount: deliverables.length,
    closedAt,
    timeline,
  };
}

/* Last close date from `## Timeline`, or null when the section is missing or
 * carries no Closed line. Scans the section bottom-up so a reopened project
 * (Closed → reopened → Closed again) yields the most recent date. */
function extractClosedAt(lines: readonly string[]): string | null {
  let timelineStart = -1;
  let timelineEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(HEADING2);
    if (!heading) continue;
    if (heading[1].trim().toLowerCase() === 'timeline') {
      timelineStart = i + 1;
    } else if (timelineStart !== -1) {
      timelineEnd = i;
      break;
    }
  }
  if (timelineStart === -1) return null;
  for (let i = timelineEnd - 1; i >= timelineStart; i--) {
    const m = lines[i].match(CLOSED_LINE);
    if (m) return m[1];
  }
  return null;
}

function extractSummary(lines: readonly string[]): string | undefined {
  let inFirstSection = false;
  let buffer: string[] = [];

  for (const line of lines) {
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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

  for (const line of lines) {
    const heading = line.match(HEADING2);
    if (heading) {
      inDeliverables = heading[1].trim().toLowerCase().startsWith('deliverable');
      continue;
    }
    if (!inDeliverables) continue;
    const match = line.match(DELIVERABLE_LINE);
    if (!match) continue;
    const [, label, rawPath, description] = match;
    const absolute = isAbsolute(rawPath) ? rawPath : resolve(itemDir, rawPath);
    out.push({
      label: label.trim(),
      path: toPosix(absolute),
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
