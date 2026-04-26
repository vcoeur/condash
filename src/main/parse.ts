import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type {
  Deliverable,
  ItemKind,
  Project,
  Step,
  StepCounts,
  StepMarker,
} from '../shared/types';

const META_LINE = /^\*\*([A-Za-z][\w -]*)\*\*\s*:\s*(.+?)\s*$/;
const HEADING2 = /^##\s+(.+)$/;
const STEP_LINE = /^\s*-\s\[([ ~x-])\]\s+(.*)$/;
const DELIVERABLE_LINE = /^\s*-\s\[([^\]]+)\]\(([^)]+\.pdf)\)(?:\s*[—\-:]\s*(.*))?\s*$/i;
const SUMMARY_MAX = 300;

export async function parseReadme(path: string): Promise<Project> {
  const raw = await fs.readFile(path, 'utf8');
  const lines = raw.split(/\r?\n/);

  const title = extractTitle(lines);
  const meta = extractMetadata(lines);
  const summary = extractSummary(lines);
  const steps = extractSteps(lines);
  const stepCounts = countSteps(steps);
  const deliverables = extractDeliverables(lines, dirname(path));

  const slug = basename(dirname(path));

  return {
    slug,
    path,
    title: title ?? slug,
    kind: normaliseKind(meta.get('kind')),
    status: (meta.get('status') ?? 'backlog').toLowerCase(),
    apps: meta.get('apps'),
    summary,
    steps,
    stepCounts,
    deliverables,
    deliverableCount: deliverables.length,
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

function countSteps(steps: readonly Step[]): StepCounts {
  const counts: StepCounts = { todo: 0, doing: 0, done: 0, dropped: 0 };
  for (const step of steps) {
    switch (step.marker) {
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
      path: absolute,
      description: description?.trim() || undefined,
    });
  }
  return out;
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
