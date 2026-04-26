import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ItemKind, Project, StepCounts } from '../shared/types';

const META_LINE = /^\*\*([A-Za-z][\w -]*)\*\*\s*:\s*(.+?)\s*$/;
const HEADING2 = /^##\s+(.+)$/;
const STEP_LINE = /^\s*-\s\[([ ~x-])\]\s/;
const DELIVERABLE_LINE = /^\s*-\s\[[^\]]+\]\([^)]+\.pdf\)/i;
const SUMMARY_MAX = 300;

export async function parseReadme(path: string): Promise<Project> {
  const raw = await fs.readFile(path, 'utf8');
  const lines = raw.split(/\r?\n/);

  const title = extractTitle(lines);
  const meta = extractMetadata(lines);
  const summary = extractSummary(lines);
  const stepCounts = countSteps(lines);
  const deliverableCount = countDeliverables(lines);

  const slug = basename(dirname(path));

  return {
    slug,
    path,
    title: title ?? slug,
    kind: normaliseKind(meta.get('kind')),
    status: (meta.get('status') ?? 'backlog').toLowerCase(),
    apps: meta.get('apps'),
    summary,
    stepCounts,
    deliverableCount,
  };
}

function extractTitle(lines: readonly string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').trim() || null;
  }
  return null;
}

function extractMetadata(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let pastTitle = false;

  for (const line of lines) {
    if (HEADING2.test(line)) break;
    if (!pastTitle) {
      if (line.trim()) pastTitle = true;
      continue;
    }
    const match = line.match(META_LINE);
    if (match) {
      const [, key, value] = match;
      out.set(key.toLowerCase(), value);
    }
  }
  return out;
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

function countSteps(lines: readonly string[]): StepCounts {
  const counts: StepCounts = { todo: 0, doing: 0, done: 0, dropped: 0 };
  for (const line of lines) {
    const match = line.match(STEP_LINE);
    if (!match) continue;
    switch (match[1]) {
      case ' ':
        counts.todo++;
        break;
      case '~':
        counts.doing++;
        break;
      case 'x':
        counts.done++;
        break;
      case '-':
        counts.dropped++;
        break;
    }
  }
  return counts;
}

function countDeliverables(lines: readonly string[]): number {
  let inDeliverables = false;
  let count = 0;

  for (const line of lines) {
    const heading = line.match(HEADING2);
    if (heading) {
      inDeliverables = heading[1].trim().toLowerCase().startsWith('deliverable');
      continue;
    }
    if (!inDeliverables) continue;
    if (DELIVERABLE_LINE.test(line)) count++;
  }
  return count;
}

function normaliseKind(value: string | undefined): ItemKind {
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
