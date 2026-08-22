/**
 * `exec` forces `LC_ALL=C` on git children so the sync error classifiers —
 * which pattern-match git's own stderr (`nothing to commit`, `does not exist
 * in`, …) — see English messages regardless of the host locale. A shim named
 * `git` earlier on PATH reports the `LC_ALL` it was actually handed.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from './exec';

describe('exec git locale pinning', () => {
  let binDir: string;
  let savedPath: string | undefined;
  let savedLocale: string | undefined;

  beforeEach(() => {
    savedPath = process.env.PATH;
    savedLocale = process.env.LC_ALL;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    if (savedLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = savedLocale;
    if (binDir) await fs.rm(binDir, { recursive: true, force: true });
  });

  it('forces LC_ALL=C on git children even under a non-English host locale', async () => {
    binDir = await fs.mkdtemp(join(tmpdir(), 'condash-exec-locale-'));
    const shim = join(binDir, 'git');
    await fs.writeFile(shim, '#!/bin/sh\nprintf %s "$LC_ALL"\n', { mode: 0o755 });
    process.env.LC_ALL = 'fr_FR.UTF-8';

    process.env.PATH = `${binDir}:${savedPath}`;
    const { stdout } = await exec('git', ['--version']);

    expect(stdout).toBe('C');
  });
});
