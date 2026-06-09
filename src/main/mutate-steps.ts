import { promises as fs } from 'node:fs';
import type { StepMarker } from '../shared/types';
import { STEP_MARKERS } from '../shared/types';
import { iterUnfencedLines } from '../shared/header';
import { atomicWrite } from './atomic-write';
import { detectEol, withFileQueue } from './mutate-shared';

/**
 * `## Steps` checklist editing: toggle a marker, edit a step's text, and
 * append a new step. The three writers share the step-line regex and the
 * `withFileQueue` lock from `mutate-shared`; status/timeline editing lives in
 * `mutate-status.ts`.
 */

// One regex for both shapes: capture the step text in group 4 so callers
// that need the body text use it; callers that only need the marker can
// ignore the trailing group. Replaces a near-byte-identical pair where
// the only difference was whether `(.*)` lived inside or outside the
// `]\s` capture — easy to drift, never observed working independently.
const STEP_LINE_RE = /^(\s*-\s\[)([ ~x!-])(\]\s)(.*)$/;
const HEADING2_RE = /^##\s+(.+)$/;

export async function toggleStep(
  path: string,
  lineIndex: number,
  expectedMarker: StepMarker,
  newMarker: StepMarker,
): Promise<void> {
  // Runtime-validate both markers — the StepMarker TS type narrows at
  // compile time but a hostile (or buggy) renderer could pass any string
  // through the IPC boundary, and the marker is written verbatim into
  // the README ("- [<m>] …"). Reject anything that's not in STEP_MARKERS.
  // Don't echo the raw value in the error — it crossed the IPC boundary
  // unvalidated; reflecting it back leaks renderer input shape into logs.
  const markerHint = `(expected one of '${STEP_MARKERS.join("', '")}')`;
  if (!(STEP_MARKERS as readonly string[]).includes(expectedMarker)) {
    throw new Error(`toggleStep: invalid expectedMarker ${markerHint}`);
  }
  if (!(STEP_MARKERS as readonly string[]).includes(newMarker)) {
    throw new Error(`toggleStep: invalid newMarker ${markerHint}`);
  }
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
    const eol = detectEol(raw);
    const lines = raw.split(/\r?\n/);

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`Line index ${lineIndex} out of range`);
    }

    const match = lines[lineIndex].match(STEP_LINE_RE);
    if (!match) {
      throw new Error(`Line ${lineIndex} is not a step`);
    }
    if (match[2] !== expectedMarker) {
      throw new Error(
        `Drift: expected marker '${expectedMarker}' at line ${lineIndex} but found '${match[2]}'`,
      );
    }

    lines[lineIndex] = `${match[1]}${newMarker}${match[3]}${match[4]}`;
    await atomicWrite(path, lines.join(eol));
  });
}

export async function editStepText(
  path: string,
  lineIndex: number,
  expectedText: string,
  newText: string,
): Promise<void> {
  const trimmed = newText.trim();
  if (!trimmed) {
    throw new Error('Step text cannot be empty');
  }
  if (/\r|\n/.test(trimmed)) {
    throw new Error('Step text cannot contain line breaks');
  }
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
    const eol = detectEol(raw);
    const lines = raw.split(/\r?\n/);

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`Line index ${lineIndex} out of range`);
    }

    const match = lines[lineIndex].match(STEP_LINE_RE);
    if (!match) {
      throw new Error(`Line ${lineIndex} is not a step`);
    }
    if (match[4].trim() !== expectedText.trim()) {
      throw new Error(
        `Drift: step text at line ${lineIndex} doesn't match expected text — reload before editing`,
      );
    }

    lines[lineIndex] = `${match[1]}${match[2]}${match[3]}${trimmed}`;
    await atomicWrite(path, lines.join(eol));
  });
}

/**
 * Append a new `- [ ] text` line to the `## Steps` section. Inserts after
 * the last existing step in that section; if the section has no steps yet,
 * inserts directly under the heading and (if needed) leaves a blank line
 * separating the new step from the next section. Creates the section at
 * end-of-file when the README has no `## Steps` heading at all.
 */
export async function addStep(path: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Step text cannot be empty');
  }
  if (/\r|\n/.test(trimmed)) {
    throw new Error('Step text cannot contain line breaks');
  }
  return withFileQueue(path, async () => {
    const raw = await fs.readFile(path, 'utf8');
    const eol = detectEol(raw);
    const lines = raw.split(/\r?\n/);

    // Fenced code blocks can contain `##` lines that aren't headings (a
    // Markdown example, a shell prompt). `iterUnfencedLines` skips them so
    // we don't pick those up as section anchors.
    let stepsStart = -1;
    let stepsEnd = lines.length;
    for (const { index: i, line } of iterUnfencedLines(lines)) {
      const heading = line.match(HEADING2_RE);
      if (!heading) continue;
      if (stepsStart === -1 && heading[1].trim().toLowerCase() === 'steps') {
        stepsStart = i;
        continue;
      }
      if (stepsStart !== -1) {
        stepsEnd = i;
        break;
      }
    }

    const newLine = `- [ ] ${trimmed}`;

    if (stepsStart === -1) {
      // No `## Steps` section yet. Append one at the end of the file. Leave
      // a blank line above the new heading if the file doesn't already end
      // with one, so the section doesn't glue itself to whatever came before.
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      if (lines.length > 0) lines.push('');
      lines.push('## Steps');
      lines.push('');
      lines.push(newLine);
      lines.push('');
      await atomicWrite(path, lines.join(eol));
      return;
    }

    let insertAt = -1;
    for (let i = stepsEnd - 1; i > stepsStart; i--) {
      if (STEP_LINE_RE.test(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt === -1) {
      // Section has no step yet — collapse any blank lines between the
      // heading and the next section, then re-emit `<blank>, step, <blank>`
      // so the new step sits one line below `## Steps` and one above
      // whatever follows.
      let blankRunEnd = stepsStart + 1;
      while (blankRunEnd < stepsEnd && lines[blankRunEnd].trim() === '') {
        blankRunEnd++;
      }
      const replacement: string[] = ['', newLine];
      // If a sibling section follows (rather than EOF), keep a blank line
      // separator. EOF doesn't need a trailing blank — `lines.join('\n')`
      // emits the final newline already if the file ended with one.
      if (blankRunEnd < lines.length) replacement.push('');
      lines.splice(stepsStart + 1, blankRunEnd - (stepsStart + 1), ...replacement);
    } else {
      // Trim trailing blank lines so the insert sits flush with the existing list.
      while (insertAt - 1 > stepsStart && lines[insertAt - 1].trim() === '') {
        insertAt--;
      }
      lines.splice(insertAt, 0, newLine);
    }

    await atomicWrite(path, lines.join(eol));
  });
}
