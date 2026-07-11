import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFirstHeadingOrLine, matchPrepared, prepareFile } from './match';
import { parseQuery } from './query';

describe('prepareFile / matchPrepared — offset integrity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'condash-match-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps offsets aligned when content contains U+0130 (length-changing lowercase)', async () => {
    const path = join(dir, 'doc.md');
    // Ten İ chars before the H1 line: a plain toLowerCase() would grow the
    // lowered string by 10 code units, pushing the matched offset past the H1
    // line boundary and into the body region.
    const raw = `${'İ'.repeat(10)}\n# needle\n${'x'.repeat(50)}\n`;
    await writeFile(path, raw);

    const prepared = await prepareFile({ path, relPath: 'doc.md', source: 'knowledge' });
    expect(prepared).not.toBeNull();
    expect(prepared!.lowerContent.length).toBe(prepared!.raw.length);

    const out = matchPrepared(prepared!, parseQuery('needle'));
    expect(out).not.toBeNull();
    // Exactly one content occurrence, inside the H1 region → score is the h1
    // weight (20). A desynced offset would land in body (score 1).
    expect(out!.hit.score).toBe(20);

    // Snippet highlight offsets must point at the actual matched text.
    const snippet = out!.hit.snippets[0];
    const match = snippet.matches[0];
    expect(snippet.text.slice(match.start, match.start + match.length)).toBe('needle');
  });
});

describe('extractFirstHeadingOrLine', () => {
  it('strips leading heading hashes', () => {
    expect(extractFirstHeadingOrLine('# Title')).toBe('Title');
  });

  it('skips YAML front matter and returns the first heading', () => {
    const raw = '---\ndate: 2026-05-13\n---\n# Project title\nbody\n';
    expect(extractFirstHeadingOrLine(raw)).toBe('Project title');
  });

  it('falls back to the first non-empty line after front matter when there is no heading', () => {
    const raw = '---\nkey: value\n---\nbody line\n';
    expect(extractFirstHeadingOrLine(raw)).toBe('body line');
  });

  it('returns null for an empty file', () => {
    expect(extractFirstHeadingOrLine('')).toBeNull();
  });
});
