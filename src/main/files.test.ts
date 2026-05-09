import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectFiles } from './files';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-files-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readme(): string {
  writeFileSync(join(tmp, 'README.md'), '# proj');
  return join(tmp, 'README.md');
}

describe('listProjectFiles', () => {
  it('returns top-level files', async () => {
    const r = readme();
    writeFileSync(join(tmp, 'extra.md'), 'x');
    const files = await listProjectFiles(r);
    expect(new Set(files.map((f) => f.relPath))).toEqual(new Set(['README.md', 'extra.md']));
  });

  it('returns one-level nested files', async () => {
    const r = readme();
    mkdirSync(join(tmp, 'notes'));
    writeFileSync(join(tmp, 'notes', '01-design.md'), 'd');
    const files = await listProjectFiles(r);
    expect(new Set(files.map((f) => f.relPath))).toEqual(
      new Set(['README.md', 'notes/01-design.md']),
    );
  });

  it('walks deeper than one nested level (regression: local/candidates/* must surface)', async () => {
    const r = readme();
    mkdirSync(join(tmp, 'local'));
    mkdirSync(join(tmp, 'local', 'candidates'));
    mkdirSync(join(tmp, 'local', 'family'));
    writeFileSync(join(tmp, 'local', 'candidates', 'a.png'), 'p');
    writeFileSync(join(tmp, 'local', 'family', 'family-sheet.png'), 'p');
    const files = await listProjectFiles(r);
    expect(new Set(files.map((f) => f.relPath))).toEqual(
      new Set(['README.md', 'local/candidates/a.png', 'local/family/family-sheet.png']),
    );
  });

  it('skips dotfiles and dot-directories at every depth', async () => {
    const r = readme();
    writeFileSync(join(tmp, '.hidden'), 'h');
    mkdirSync(join(tmp, '.git'));
    writeFileSync(join(tmp, '.git', 'config'), 'c');
    mkdirSync(join(tmp, 'notes'));
    writeFileSync(join(tmp, 'notes', '.draft'), 'd');
    writeFileSync(join(tmp, 'notes', '01.md'), 'x');
    const files = await listProjectFiles(r);
    expect(new Set(files.map((f) => f.relPath))).toEqual(new Set(['README.md', 'notes/01.md']));
  });

  it('returns entries sorted by relPath via localeCompare', async () => {
    const r = readme();
    mkdirSync(join(tmp, 'local'));
    writeFileSync(join(tmp, 'local', 'a.png'), 'p');
    mkdirSync(join(tmp, 'notes'));
    writeFileSync(join(tmp, 'notes', '01.md'), 'x');
    const files = await listProjectFiles(r);
    const rels = files.map((f) => f.relPath);
    const sorted = [...rels].sort((a, b) => a.localeCompare(b));
    expect(rels).toEqual(sorted);
  });

  it('emits absolute path, posix relPath, and basename', async () => {
    const r = readme();
    mkdirSync(join(tmp, 'local'));
    mkdirSync(join(tmp, 'local', 'candidates'));
    writeFileSync(join(tmp, 'local', 'candidates', 'a.png'), 'p');
    const files = await listProjectFiles(r);
    const a = files.find((f) => f.name === 'a.png')!;
    expect(a.relPath).toBe('local/candidates/a.png');
    expect(a.path.endsWith('/local/candidates/a.png')).toBe(true);
  });

  it('returns [] when the directory is unreadable / missing', async () => {
    const files = await listProjectFiles(join(tmp, 'no-such', 'README.md'));
    expect(files).toEqual([]);
  });
});
