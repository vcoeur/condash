/**
 * Focused tests for `readManifest` / `writeManifest` — exercises the
 * one-shot migration from the legacy `.claude/skills/.condash-skills.json`
 * path to the new `.agents/.condash-skills.json` path without going through
 * `runSkills` (which would overwrite the file as a side-effect).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANIFEST_RELPATH, MANIFEST_VERSION, readManifest, writeManifest } from './install-shared';

let dest: string;

beforeEach(async () => {
  dest = await fs.mkdtemp(join(tmpdir(), 'install-shared-'));
});

afterEach(async () => {
  await fs.rm(dest, { recursive: true, force: true });
});

const legacyPath = (root: string): string => join(root, '.claude', 'skills', MANIFEST_RELPATH);
const newPath = (root: string): string => join(root, '.agents', MANIFEST_RELPATH);

describe('readManifest source-manifest migration', () => {
  it('returns null when neither location has a manifest', async () => {
    const manifest = await readManifest(dest);
    expect(manifest).toBeNull();
  });

  it('reads from .agents/ when present and leaves the legacy path untouched', async () => {
    const fixture = {
      version: MANIFEST_VERSION,
      skills: {
        foo: { source: { 'spec.yaml': { sha256: 'a'.repeat(64), shippedVersion: '3.7.0' } } },
      },
    };
    await fs.mkdir(join(dest, '.agents'), { recursive: true });
    await fs.writeFile(newPath(dest), JSON.stringify(fixture));
    // Plant a stale legacy file too — it should not be read or moved.
    await fs.mkdir(join(dest, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(legacyPath(dest), JSON.stringify({ version: MANIFEST_VERSION, skills: {} }));

    const manifest = await readManifest(dest);
    expect(manifest?.version).toBe(MANIFEST_VERSION);
    expect(manifest?.skills.foo).toBeTruthy();
    // Legacy path still exists — we only migrate when .agents/ is missing.
    await expect(fs.access(legacyPath(dest))).resolves.toBeUndefined();
  });

  it('migrates the legacy file to .agents/ on first read and returns the parsed manifest', async () => {
    const fixture = {
      version: MANIFEST_VERSION,
      skills: {
        pr: { source: { 'spec.yaml': { sha256: 'b'.repeat(64), shippedVersion: '3.7.0' } } },
      },
    };
    await fs.mkdir(join(dest, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(legacyPath(dest), JSON.stringify(fixture, null, 2));

    const manifest = await readManifest(dest);
    expect(manifest?.version).toBe(MANIFEST_VERSION);
    expect(manifest?.skills.pr).toBeTruthy();

    // Legacy file is gone …
    await expect(fs.access(legacyPath(dest))).rejects.toThrow();
    // … and the new file is in place.
    await expect(fs.access(newPath(dest))).resolves.toBeUndefined();
  });

  it('is idempotent — a second readManifest after a migration is a no-op', async () => {
    const fixture = { version: MANIFEST_VERSION, skills: {} };
    await fs.mkdir(join(dest, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(legacyPath(dest), JSON.stringify(fixture));

    const first = await readManifest(dest);
    expect(first).not.toBeNull();
    const newPathStat = await fs.stat(newPath(dest));

    const second = await readManifest(dest);
    expect(second).not.toBeNull();
    const newPathStatAgain = await fs.stat(newPath(dest));
    // mtime unchanged — the second read did not rewrite the file.
    expect(newPathStatAgain.mtimeMs).toBe(newPathStat.mtimeMs);
  });

  it('migrates v1 schemas in memory before persisting them at the new path', async () => {
    await fs.mkdir(join(dest, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(
      legacyPath(dest),
      JSON.stringify({
        version: 1,
        skills: {},
        templates: {
          'AGENTS.md': { region: 'General', sha256: 'c'.repeat(64), shippedVersion: '2.27.0' },
        },
      }),
    );

    const manifest = await readManifest(dest);
    expect(manifest?.version).toBe(MANIFEST_VERSION);
    expect(manifest?.files?.['AGENTS.md']).toBeTruthy();
    // The legacy file has been moved; the on-disk content at the new
    // location is the raw v1 bytes (`writeManifest` later in `installRepo`
    // upgrades them) — but the in-memory return is v3.
    await expect(fs.access(legacyPath(dest))).rejects.toThrow();
  });

  it('refuses to migrate a corrupt legacy file', async () => {
    await fs.mkdir(join(dest, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(legacyPath(dest), '{not-json');

    await expect(readManifest(dest)).rejects.toThrow(/parse manifest/);
    // Legacy file is still in place — migration short-circuits on parse failure.
    await expect(fs.access(legacyPath(dest))).resolves.toBeUndefined();
    await expect(fs.access(newPath(dest))).rejects.toThrow();
  });
});

describe('writeManifest', () => {
  it('always writes to .agents/.condash-skills.json regardless of legacy presence', async () => {
    await fs.mkdir(join(dest, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(legacyPath(dest), JSON.stringify({ version: MANIFEST_VERSION, skills: {} }));

    await writeManifest(dest, { version: MANIFEST_VERSION, skills: {} });
    await expect(fs.access(newPath(dest))).resolves.toBeUndefined();
    // Pre-existing legacy file is untouched by writeManifest — only readManifest moves it.
    await expect(fs.access(legacyPath(dest))).resolves.toBeUndefined();
  });
});
