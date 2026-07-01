import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseReadme } from './parse';

let tmp = '';
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'condash-parse-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeReadme(slug: string, body: string): Promise<string> {
  const dir = join(tmp, slug);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, 'README.md');
  await fs.writeFile(path, body, 'utf8');
  return path;
}

describe('countSteps section filtering', () => {
  it('only counts steps under ## Steps, not ## Step details', async () => {
    const body = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Steps

- [ ] one
- [ ] two
- [x] three

## Step details

- [ ] sub one
- [ ] sub two
- [ ] sub three
`;
    const path = await writeReadme('2026-05-19-section-filter', body);
    const project = await parseReadme(path);
    expect(project.stepCounts).toEqual({
      todo: 2,
      doing: 0,
      done: 1,
      blocked: 0,
      dropped: 0,
    });
    // extractSteps still records every checkbox so an editor that re-renders
    // the list (e.g. Step-details edits) can find them.
    expect(project.steps).toHaveLength(6);
  });

  it('counts entries across multiple ## Steps headings', async () => {
    const body = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Steps

- [ ] a

## Notes

text

## Steps

- [x] b
`;
    const path = await writeReadme('2026-05-19-multi-steps', body);
    const project = await parseReadme(path);
    expect(project.stepCounts.todo).toBe(1);
    expect(project.stepCounts.done).toBe(1);
  });
});

describe('fence-aware parsing', () => {
  it('ignores - [ ] inside a fenced code block', async () => {
    const body = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Goal

\`\`\`markdown
- [ ] this is documentation, not a real step
- [ ] same here
\`\`\`

## Steps

- [ ] one real step
`;
    const path = await writeReadme('2026-05-19-fenced-backtick', body);
    const project = await parseReadme(path);
    expect(project.stepCounts.todo).toBe(1);
  });

  it('ignores - [ ] inside a ~~~-fenced code block', async () => {
    const body = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Goal

~~~
- [ ] not a step
~~~

## Steps

- [x] one
`;
    const path = await writeReadme('2026-05-19-fenced-tilde', body);
    const project = await parseReadme(path);
    expect(project.stepCounts.done).toBe(1);
    expect(project.stepCounts.todo).toBe(0);
  });

  it('extractClosedAt ignores Closed lines inside a fence', async () => {
    const body = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Timeline

\`\`\`
- 2099-01-01 — Closed. fake
\`\`\`

- 2026-05-15 — Closed.
`;
    const path = await writeReadme('2026-05-19-fenced-timeline', body);
    const project = await parseReadme(path);
    expect(project.closedAt).toBe('2026-05-15');
  });
});

describe('[!] step marker', () => {
  it('parses and counts blocked steps', async () => {
    const body = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Steps

- [ ] todo
- [~] doing
- [!] blocked on review
- [x] done
- [-] dropped
`;
    const path = await writeReadme('2026-05-19-blocked', body);
    const project = await parseReadme(path);
    expect(project.stepCounts).toEqual({
      todo: 1,
      doing: 1,
      done: 1,
      blocked: 1,
      dropped: 1,
    });
    const blocked = project.steps.find((s) => s.marker === '!');
    expect(blocked?.text).toBe('blocked on review');
  });
});

describe('BOM + CRLF tolerance', () => {
  it('parses a BOM-prefixed README', async () => {
    const body = `﻿---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Steps

- [ ] one
`;
    const path = await writeReadme('2026-05-19-bom', body);
    const project = await parseReadme(path);
    expect(project.title).toBe('Test');
    expect(project.stepCounts.todo).toBe(1);
  });

  it('countSteps matches LF and CRLF versions', async () => {
    const lf = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Steps

- [ ] one
- [x] two
`;
    const lfPath = await writeReadme('2026-05-19-lf', lf);
    const crlfPath = await writeReadme('2026-05-19-crlf', lf.replace(/\n/g, '\r\n'));
    const lfProject = await parseReadme(lfPath);
    const crlfProject = await parseReadme(crlfPath);
    expect(crlfProject.stepCounts).toEqual(lfProject.stepCounts);
  });
});

describe('indented child steps', () => {
  it("counts indented - [ ] entries (today's behaviour)", async () => {
    const body = `---
date: 2026-05-19
kind: project
status: now
apps: []
---

# Test

## Steps

- [ ] parent
  - [ ] child one
  - [x] child two
`;
    const path = await writeReadme('2026-05-19-indented', body);
    const project = await parseReadme(path);
    expect(project.stepCounts.todo).toBe(2);
    expect(project.stepCounts.done).toBe(1);
  });
});

describe('deliverables parsing', () => {
  const header = `---
date: 2026-05-20
kind: project
status: done
apps: []
---

# Test
`;

  it('accepts local links of any extension, not just PDF', async () => {
    const body = `${header}
## Deliverables

- [Report](report.pdf) — the compiled report
- [Module 1](outputs/module-1.html)
- [Notes export](notes/summary.md)
- [Diagram](assets/diagram.svg)
`;
    const path = await writeReadme('2026-05-20-mixed', body);
    const project = await parseReadme(path);
    const dir = join(tmp, '2026-05-20-mixed');
    expect(project.deliverableCount).toBe(4);
    expect(project.deliverables.map((d) => d.label)).toEqual([
      'Report',
      'Module 1',
      'Notes export',
      'Diagram',
    ]);
    // Local targets resolve to absolute posix paths under the project dir.
    expect(project.deliverables[0].path).toBe(join(dir, 'report.pdf').split('\\').join('/'));
    expect(project.deliverables[1].path).toBe(
      join(dir, 'outputs/module-1.html').split('\\').join('/'),
    );
    expect(project.deliverables[0].description).toBe('the compiled report');
  });

  it('keeps http(s) URLs verbatim', async () => {
    const body = `${header}
## Deliverables

- [Live module](https://example.netlify.app/module) — deployed
`;
    const path = await writeReadme('2026-05-20-url', body);
    const project = await parseReadme(path);
    expect(project.deliverables).toHaveLength(1);
    expect(project.deliverables[0].path).toBe('https://example.netlify.app/module');
    expect(project.deliverables[0].kind).toBe('url');
    expect(project.deliverables[0].description).toBe('deployed');
  });

  it('tags local-file and wikilink kinds', async () => {
    const body = `${header}
## Deliverables

- [Report](report.pdf)
- [[2026-04-01-other-project]] — see the predecessor
- [[note-slug|Design note]] — rationale
`;
    const path = await writeReadme('2026-05-20-kinds', body);
    const project = await parseReadme(path);
    expect(project.deliverables.map((d) => d.kind)).toEqual(['file', 'wikilink', 'wikilink']);
    // Wikilink: path is the raw slug; label/comment parsed.
    expect(project.deliverables[1].path).toBe('2026-04-01-other-project');
    expect(project.deliverables[1].label).toBe('2026-04-01-other-project');
    expect(project.deliverables[1].description).toBe('see the predecessor');
    // Wikilink with explicit label after `|`.
    expect(project.deliverables[2].path).toBe('note-slug');
    expect(project.deliverables[2].label).toBe('Design note');
    expect(project.deliverables[2].description).toBe('rationale');
  });

  it('skips mailto: and in-page anchors', async () => {
    const body = `${header}
## Deliverables

- [Email me](mailto:alice@example.com)
- [Section](#summary)
- [Real](file.pdf)
`;
    const path = await writeReadme('2026-05-20-skip', body);
    const project = await parseReadme(path);
    expect(project.deliverables.map((d) => d.label)).toEqual(['Real']);
  });

  it('only collects links under the ## Deliverables heading', async () => {
    const body = `${header}
## Notes

- [Not a deliverable](elsewhere.pdf)

## Deliverables

- [Yes](yes.pdf)
`;
    const path = await writeReadme('2026-05-20-scope', body);
    const project = await parseReadme(path);
    expect(project.deliverables.map((d) => d.label)).toEqual(['Yes']);
  });
});

describe('lastActivity (timeline projection scalar)', () => {
  const header = `---
date: 2026-05-19
kind: project
status: now
---

# X
`;

  it('is the most recent ## Timeline date, regardless of source order', async () => {
    const body = `${header}
## Timeline

- 2026-05-19 — opened
- 2026-05-25 — shipped
- 2026-05-21 — reviewed
`;
    const path = await writeReadme('2026-05-19-la', body);
    const project = await parseReadme(path);
    expect(project.lastActivity).toBe('2026-05-25');
  });

  it('is null when the README has no ## Timeline entries', async () => {
    const path = await writeReadme('2026-05-19-none', `${header}\n## Goal\n\nNo timeline.\n`);
    const project = await parseReadme(path);
    expect(project.lastActivity).toBeNull();
  });
});
