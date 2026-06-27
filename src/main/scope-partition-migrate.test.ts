import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { partitionSettingsScopes, scopeMigrationDidWork } from './scope-partition-migrate';
import { CONDASH_DIR, condashSettingsPath } from './condash-dir';

let tmp: string;
let globalFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-scope-'));
  // Keep the global file out of `.condash/` so the migrator's two reads never
  // alias. The conception root is `tmp` itself.
  globalFile = join(tmp, 'global-settings.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeGlobal(obj: Record<string, unknown>): void {
  writeFileSync(globalFile, JSON.stringify(obj, null, 2) + '\n');
}

function writeConception(obj: Record<string, unknown>): void {
  mkdirSync(join(tmp, CONDASH_DIR), { recursive: true });
  writeFileSync(condashSettingsPath(tmp), JSON.stringify(obj, null, 2) + '\n');
}

function readGlobal(): Record<string, unknown> {
  return JSON.parse(readFileSync(globalFile, 'utf8')) as Record<string, unknown>;
}

function readConception(): Record<string, unknown> {
  return JSON.parse(readFileSync(condashSettingsPath(tmp), 'utf8')) as Record<string, unknown>;
}

describe('partitionSettingsScopes', () => {
  it('(a) lifts a global key sitting in the conception file up to the global file', async () => {
    writeGlobal({});
    writeConception({ workspace_path: '/x', theme: 'dark' });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(result.movedToGlobal).toEqual(['theme']);
    expect(result.movedToConception).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.globalWritten).toBe(true);
    expect(result.conceptionWritten).toBe(true);
    // `theme` now lives only in the global file…
    expect(readGlobal().theme).toBe('dark');
    expect('theme' in readConception()).toBe(false);
    // …and the conception keeps its own key.
    expect(readConception().workspace_path).toBe('/x');
  });

  it('pushes a conception key sitting in the global file down to the conception file', async () => {
    writeGlobal({ theme: 'dark', workspace_path: '/x' });
    writeConception({ repositories: ['condash'] });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(result.movedToConception).toEqual(['workspace_path']);
    expect(result.movedToGlobal).toEqual([]);
    expect('workspace_path' in readGlobal()).toBe(false);
    expect(readGlobal().theme).toBe('dark');
    expect(readConception().workspace_path).toBe('/x');
    expect(readConception().repositories).toEqual(['condash']);
  });

  it('creates the .condash dir when first writing the conception file', async () => {
    // Global carries a conception-owned key but no conception file exists yet.
    writeGlobal({ theme: 'dark', worktrees_path: '/w' });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(result.movedToConception).toEqual(['worktrees_path']);
    expect(existsSync(condashSettingsPath(tmp))).toBe(true);
    expect(readConception().worktrees_path).toBe('/w');
  });

  it('(b) drops the conception copy on a conflict — the owning (global) file wins', async () => {
    writeGlobal({ theme: 'light' });
    writeConception({ theme: 'dark', workspace_path: '/x' });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(result.dropped).toEqual([{ key: 'theme', droppedFrom: 'conception' }]);
    expect(result.movedToGlobal).toEqual([]);
    // The global file keeps its own value and is not rewritten.
    expect(result.globalWritten).toBe(false);
    expect(readGlobal().theme).toBe('light');
    // The misplaced copy is gone; the conception file is rewritten without it.
    expect(result.conceptionWritten).toBe(true);
    expect('theme' in readConception()).toBe(false);
    expect(readConception().workspace_path).toBe('/x');
  });

  it('drops a global-file copy on a conflict — the owning (conception) file wins', async () => {
    writeGlobal({ workspace_path: '/from-global', theme: 'dark' });
    writeConception({ workspace_path: '/from-conception' });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(result.dropped).toEqual([{ key: 'workspace_path', droppedFrom: 'global' }]);
    expect(result.movedToConception).toEqual([]);
    // The conception file keeps its own value and is not rewritten.
    expect(result.conceptionWritten).toBe(false);
    expect(readConception().workspace_path).toBe('/from-conception');
    // The misplaced copy is stripped from the global file.
    expect(result.globalWritten).toBe(true);
    expect('workspace_path' in readGlobal()).toBe(false);
    expect(readGlobal().theme).toBe('dark');
  });

  it('(c) is idempotent — a second run moves nothing and writes nothing', async () => {
    writeGlobal({});
    writeConception({ workspace_path: '/x', theme: 'dark' });
    await partitionSettingsScopes(tmp, globalFile);

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(result.movedToGlobal).toEqual([]);
    expect(result.movedToConception).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.globalWritten).toBe(false);
    expect(result.conceptionWritten).toBe(false);
    expect(scopeMigrationDidWork(result)).toBe(false);
  });

  it('(d) no-ops on an already-partitioned pair', async () => {
    writeGlobal({ theme: 'dark', terminal: { shell: '/bin/zsh' } });
    writeConception({ workspace_path: '/x', repositories: ['condash'] });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(scopeMigrationDidWork(result)).toBe(false);
    expect(result.globalWritten).toBe(false);
    expect(result.conceptionWritten).toBe(false);
    // Both files are untouched.
    expect(readGlobal()).toEqual({ theme: 'dark', terminal: { shell: '/bin/zsh' } });
    expect(readConception()).toEqual({ workspace_path: '/x', repositories: ['condash'] });
  });

  it('(e) leaves $schema_doc in whichever file already carries it', async () => {
    writeGlobal({ $schema_doc: 'global-doc', theme: 'dark' });
    writeConception({ $schema_doc: 'conception-doc', workspace_path: '/x' });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(scopeMigrationDidWork(result)).toBe(false);
    expect(result.globalWritten).toBe(false);
    expect(result.conceptionWritten).toBe(false);
    expect(readGlobal().$schema_doc).toBe('global-doc');
    expect(readConception().$schema_doc).toBe('conception-doc');
  });

  it('(f) leaves an unknown key (absent from SCOPE_OF) in place', async () => {
    writeGlobal({ mystery_global: 1, theme: 'dark' });
    writeConception({ mystery_conception: 2, workspace_path: '/x' });

    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(scopeMigrationDidWork(result)).toBe(false);
    expect(result.globalWritten).toBe(false);
    expect(result.conceptionWritten).toBe(false);
    expect(readGlobal().mystery_global).toBe(1);
    expect(readConception().mystery_conception).toBe(2);
  });

  it('handles both files missing — no work, no writes', async () => {
    const result = await partitionSettingsScopes(tmp, globalFile);

    expect(scopeMigrationDidWork(result)).toBe(false);
    expect(result.globalWritten).toBe(false);
    expect(result.conceptionWritten).toBe(false);
    expect(result.conception).toBe(tmp);
    expect(existsSync(globalFile)).toBe(false);
    expect(existsSync(condashSettingsPath(tmp))).toBe(false);
  });
});

describe('scopeMigrationDidWork', () => {
  it('is true when a key moved and false otherwise', () => {
    const base = {
      conception: '/c',
      movedToGlobal: [] as string[],
      movedToConception: [] as string[],
      dropped: [] as { key: string; droppedFrom: 'global' | 'conception' }[],
      globalWritten: false,
      conceptionWritten: false,
    };
    expect(scopeMigrationDidWork(base)).toBe(false);
    expect(scopeMigrationDidWork({ ...base, movedToGlobal: ['theme'] })).toBe(true);
    expect(scopeMigrationDidWork({ ...base, movedToConception: ['workspace_path'] })).toBe(true);
    expect(
      scopeMigrationDidWork({ ...base, dropped: [{ key: 'theme', droppedFrom: 'conception' }] }),
    ).toBe(true);
  });
});
