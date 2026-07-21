import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanDirRelPath,
  createProjectEntry,
  listProjectFiles,
  requireCreatableName,
} from './files';

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
    expect(files.every((f) => f.kind === 'file')).toBe(true);
  });

  it('emits directory entries alongside their files', async () => {
    const r = readme();
    mkdirSync(join(tmp, 'notes'));
    writeFileSync(join(tmp, 'notes', '01-design.md'), 'd');
    const files = await listProjectFiles(r);
    expect(new Set(files.map((f) => `${f.kind}:${f.relPath}`))).toEqual(
      new Set(['file:README.md', 'dir:notes', 'file:notes/01-design.md']),
    );
  });

  it('surfaces empty directories', async () => {
    const r = readme();
    mkdirSync(join(tmp, 'scripts'));
    const files = await listProjectFiles(r);
    const scripts = files.find((f) => f.relPath === 'scripts');
    expect(scripts).toMatchObject({ kind: 'dir', name: 'scripts' });
  });

  it('walks deeper than one nested level (regression: local/candidates/* must surface)', async () => {
    const r = readme();
    mkdirSync(join(tmp, 'local'));
    mkdirSync(join(tmp, 'local', 'candidates'));
    mkdirSync(join(tmp, 'local', 'family'));
    writeFileSync(join(tmp, 'local', 'candidates', 'a.png'), 'p');
    writeFileSync(join(tmp, 'local', 'family', 'family-sheet.png'), 'p');
    const files = await listProjectFiles(r);
    expect(new Set(files.filter((f) => f.kind === 'file').map((f) => f.relPath))).toEqual(
      new Set(['README.md', 'local/candidates/a.png', 'local/family/family-sheet.png']),
    );
    expect(new Set(files.filter((f) => f.kind === 'dir').map((f) => f.relPath))).toEqual(
      new Set(['local', 'local/candidates', 'local/family']),
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
    expect(new Set(files.map((f) => f.relPath))).toEqual(
      new Set(['README.md', 'notes', 'notes/01.md']),
    );
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
    const dir = files.find((f) => f.relPath === 'local/candidates')!;
    expect(dir.name).toBe('candidates');
    expect(dir.path.endsWith('/local/candidates')).toBe(true);
  });

  it('returns [] when the directory is unreadable / missing', async () => {
    const files = await listProjectFiles(join(tmp, 'no-such', 'README.md'));
    expect(files).toEqual([]);
  });
});

describe('requireCreatableName', () => {
  it('accepts ordinary names verbatim (trimmed)', () => {
    expect(requireCreatableName('notes.md')).toBe('notes.md');
    expect(requireCreatableName('  Makefile ')).toBe('Makefile');
    expect(requireCreatableName('foo..bar')).toBe('foo..bar');
  });

  it('rejects empty and whitespace-only names', () => {
    expect(() => requireCreatableName('')).toThrow(/empty/);
    expect(() => requireCreatableName('   ')).toThrow(/empty/);
  });

  it('rejects path separators', () => {
    expect(() => requireCreatableName('a/b')).toThrow(/separator/);
    expect(() => requireCreatableName('a\\b')).toThrow(/separator/);
  });

  it('rejects leading dots and dot segments', () => {
    expect(() => requireCreatableName('.hidden')).toThrow(/dot/);
    expect(() => requireCreatableName('..')).toThrow(/dot/);
    expect(() => requireCreatableName('.')).toThrow(/dot/);
  });
});

describe('cleanDirRelPath', () => {
  it('maps empty and dot to the project root', () => {
    expect(cleanDirRelPath('')).toBe('');
    expect(cleanDirRelPath('.')).toBe('');
  });

  it('keeps normal nested paths', () => {
    expect(cleanDirRelPath('notes')).toBe('notes');
    expect(cleanDirRelPath('local/candidates')).toBe('local/candidates');
  });

  it('rejects absolute paths', () => {
    expect(() => cleanDirRelPath('/etc')).toThrow(/relative/);
  });

  it('rejects .. traversal, including post-normalize survivors', () => {
    expect(() => cleanDirRelPath('..')).toThrow(/escapes/);
    expect(() => cleanDirRelPath('../outside')).toThrow(/escapes/);
    expect(() => cleanDirRelPath('notes/../../outside')).toThrow(/escapes/);
  });

  it('normalizes away internal dot segments', () => {
    expect(cleanDirRelPath('notes/../local')).toBe('local');
    expect(cleanDirRelPath('./notes')).toBe('notes');
  });

  it('does not flag dotted filenames as traversal', () => {
    expect(cleanDirRelPath('notes/foo..bar')).toBe('notes/foo..bar');
  });
});

describe('createProjectEntry', () => {
  it('creates an empty file and returns its posix path', async () => {
    const path = await createProjectEntry(tmp, 'todo.md', 'file');
    expect(path.endsWith('/todo.md')).toBe(true);
    expect(readFileSync(join(tmp, 'todo.md'), 'utf8')).toBe('');
  });

  it('creates a directory', async () => {
    await createProjectEntry(tmp, 'scripts', 'dir');
    expect(statSync(join(tmp, 'scripts')).isDirectory()).toBe(true);
  });

  it('rejects an existing file target', async () => {
    writeFileSync(join(tmp, 'todo.md'), 'keep');
    await expect(createProjectEntry(tmp, 'todo.md', 'file')).rejects.toThrow(/already exists/);
    expect(readFileSync(join(tmp, 'todo.md'), 'utf8')).toBe('keep');
  });

  it('rejects an existing directory target', async () => {
    mkdirSync(join(tmp, 'scripts'));
    await expect(createProjectEntry(tmp, 'scripts', 'dir')).rejects.toThrow(/already exists/);
  });

  it('rejects a symlink squatting on the target name', async () => {
    symlinkSync(join(tmp, 'nowhere'), join(tmp, 'sneaky'));
    await expect(createProjectEntry(tmp, 'sneaky', 'file')).rejects.toThrow(/already exists/);
    await expect(createProjectEntry(tmp, 'sneaky', 'dir')).rejects.toThrow(/already exists/);
    expect(existsSync(join(tmp, 'nowhere'))).toBe(false);
  });
});
