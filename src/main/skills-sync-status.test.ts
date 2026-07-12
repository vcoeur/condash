/**
 * Unit tests for the shipped-skills sync aggregate. Each case builds a shipped
 * source tree + an installed `.agents/skills` tree (+ optional manifest) in a
 * tmpdir and asserts the classification the status-bar indicator reads.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSkillsSyncStatus } from './skills-sync-status';

let root: string;
let shippedRoot: string;
let dest: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'condash-skills-sync-'));
  shippedRoot = join(root, 'shipped');
  dest = join(root, 'conception');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex');
}

/** Write `content` to a nested path, creating parent dirs. */
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Shipped source: skill `foo` with SKILL.md + extra.md. */
function shipFoo(skillMd: string, extraMd: string): void {
  put(join(shippedRoot, 'foo', 'SKILL.md'), skillMd);
  put(join(shippedRoot, 'foo', 'extra.md'), extraMd);
}

/** Installed copy under `<dest>/.agents/skills/foo/<rel>`. */
function install(rel: string, content: string): void {
  put(join(dest, '.agents', 'skills', 'foo', rel), content);
}

/** Write the install manifest with per-file shas for skill `foo`. */
function writeManifest(files: Record<string, string>): void {
  const source: Record<string, { sha256: string; shippedVersion: string }> = {};
  for (const [rel, content] of Object.entries(files)) {
    source[rel] = { sha256: sha256(content), shippedVersion: '4.79.0' };
  }
  put(
    join(dest, '.agents', '.condash-skills.json'),
    JSON.stringify({ version: 1, skills: { foo: { source } } }),
  );
}

describe('getSkillsSyncStatus', () => {
  it('reports not-installed when nothing is on disk', async () => {
    shipFoo('a', 'b');
    const status = await getSkillsSyncStatus(shippedRoot, dest);
    expect(status).toEqual({
      installed: false,
      shippedTotal: 2,
      needsInstall: 2,
      edited: 0,
      synced: false,
    });
  });

  it('is synced when disk matches the shipped bytes', async () => {
    shipFoo('a', 'b');
    install('SKILL.md', 'a');
    install('extra.md', 'b');
    writeManifest({ 'SKILL.md': 'a', 'extra.md': 'b' });
    const status = await getSkillsSyncStatus(shippedRoot, dest);
    expect(status).toEqual({
      installed: true,
      shippedTotal: 2,
      needsInstall: 0,
      edited: 0,
      synced: true,
    });
  });

  it('flags a missing shipped file as needing install', async () => {
    shipFoo('a', 'b');
    install('SKILL.md', 'a'); // extra.md absent
    writeManifest({ 'SKILL.md': 'a', 'extra.md': 'b' });
    const status = await getSkillsSyncStatus(shippedRoot, dest);
    expect(status.installed).toBe(true);
    expect(status.needsInstall).toBe(1);
    expect(status.edited).toBe(0);
    expect(status.synced).toBe(false);
  });

  it('flags an outdated file (matches manifest, shipped moved on) as needing install', async () => {
    // Installed the OLD version (manifest records OLD); shipped is now NEW.
    shipFoo('NEW', 'b');
    install('SKILL.md', 'OLD');
    install('extra.md', 'b');
    writeManifest({ 'SKILL.md': 'OLD', 'extra.md': 'b' });
    const status = await getSkillsSyncStatus(shippedRoot, dest);
    expect(status.needsInstall).toBe(1);
    expect(status.edited).toBe(0);
    expect(status.synced).toBe(false);
  });

  it('flags a locally-edited file as edited, not needing install', async () => {
    // Manifest records the shipped version; disk differs from both → edited.
    shipFoo('SHIPPED', 'b');
    install('SKILL.md', 'EDITED');
    install('extra.md', 'b');
    writeManifest({ 'SKILL.md': 'SHIPPED', 'extra.md': 'b' });
    const status = await getSkillsSyncStatus(shippedRoot, dest);
    expect(status.needsInstall).toBe(0);
    expect(status.edited).toBe(1);
    expect(status.synced).toBe(true); // edited alone does not break sync
  });

  it('treats a missing shipped source as nothing to install', async () => {
    // No shipped root on disk at all.
    const status = await getSkillsSyncStatus(join(root, 'absent'), dest);
    expect(status).toEqual({
      installed: false,
      shippedTotal: 0,
      needsInstall: 0,
      edited: 0,
      synced: false,
    });
  });

  it('is installed (manifest present) even before any file compare', async () => {
    shipFoo('a', 'b');
    install('SKILL.md', 'a');
    install('extra.md', 'b');
    // No manifest, but files match shipped → still synced via on-disk match.
    const status = await getSkillsSyncStatus(shippedRoot, dest);
    expect(status.installed).toBe(true);
    expect(status.synced).toBe(true);
  });
});
