import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => vi.fn(async (path: string, _root: string) => path));
vi.mock('./path-bounds', () => ({ requirePathUnder: boundary }));
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({ isFile: () => true })) }));
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, resolve: actual.win32.resolve };
});
vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>();
  return {
    ...actual,
    fileURLToPath: (url: string) => actual.fileURLToPath(url, { windows: true }),
  };
});

import { resolveTerminalDocument } from './terminal-document';

beforeEach(() => boundary.mockClear());

describe('terminal document paths on Windows', () => {
  const root = 'C:\\conception';
  const cwd = 'C:\\conception\\resources';

  it.each([
    ['file:///C:/conception/resources/guide.md', 'C:\\conception\\resources\\guide.md'],
    [
      'file://localhost/C:/conception/resources/decision%20form.mdx',
      'C:\\conception\\resources\\decision form.mdx',
    ],
    ['guide.md', 'C:\\conception\\resources\\guide.md'],
  ])('passes the native path to the unchanged realpath boundary for %s', async (uri, path) => {
    await expect(resolveTerminalDocument(uri, cwd, root)).resolves.toBe(path);
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(boundary).toHaveBeenCalledWith(path, root);
  });

  it.each([
    'file://remote/C:/conception/guide.md',
    'file:///C:/conception/guide.md?query',
    'file:///C:/conception/guide%00.md',
    'file:///C:/conception/guide%5cother.md',
    'file:///C:/conception/sub%2Fguide.md',
    'javascript:guide.md',
  ])('rejects invalid file targets before filesystem access: %s', async (uri) => {
    await expect(resolveTerminalDocument(uri, cwd, root)).rejects.toThrow();
    expect(boundary).not.toHaveBeenCalled();
  });

  it('retains the realpath boundary for an absolute file URL outside the conception', async () => {
    boundary.mockRejectedValueOnce(new Error('path is outside the conception tree'));
    await expect(resolveTerminalDocument('file:///C:/outside/guide.md', cwd, root)).rejects.toThrow(
      'outside',
    );
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(boundary).toHaveBeenCalledWith('C:\\outside\\guide.md', root);
  });
});
