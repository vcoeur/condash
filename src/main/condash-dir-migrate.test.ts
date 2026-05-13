import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignoreEntry, migrateLegacyConfig } from './condash-dir-migrate';
import { CONDASH_DIR, condashSettingsPath } from './condash-dir';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-migrate-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeGitRepo(): void {
  mkdirSync(join(tmp, '.git'));
  // Minimal marker file — `migrateLegacyConfig` uses `existsSync(.git)`
  // which doesn't care about repo validity.
}

describe('migrateLegacyConfig', () => {
  it('is a no-op when the new primary already exists', async () => {
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), '{"foo":"bar"}\n');
    writeFileSync(join(tmp, 'condash.json'), '{"baz":"qux"}\n');
    const result = await migrateLegacyConfig(tmp);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('primary-already-exists');
    expect(readFileSync(join(tmp, 'condash.json'), 'utf8')).toBe('{"baz":"qux"}\n');
  });

  it('is a no-op when neither legacy file exists', async () => {
    const result = await migrateLegacyConfig(tmp);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('no-legacy-config');
    expect(existsSync(condashSettingsPath(tmp))).toBe(false);
  });

  it('migrates condash.json → .condash/settings.json and tombstones the legacy file', async () => {
    const legacyContent = '{"workspace_path":"/x"}\n';
    writeFileSync(join(tmp, 'condash.json'), legacyContent);
    const result = await migrateLegacyConfig(tmp);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(join(tmp, 'condash.json'));
    expect(result.to).toBe(condashSettingsPath(tmp));
    expect(readFileSync(condashSettingsPath(tmp), 'utf8')).toBe(legacyContent);
    const tombstone = JSON.parse(readFileSync(join(tmp, 'condash.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(tombstone._moved_to).toBe(`${CONDASH_DIR}/settings.json`);
    expect(typeof tombstone._moved_at).toBe('string');
  });

  it('falls back to configuration.json when condash.json is absent', async () => {
    const legacyContent = '{"resources_path":"resources"}\n';
    writeFileSync(join(tmp, 'configuration.json'), legacyContent);
    const result = await migrateLegacyConfig(tmp);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(join(tmp, 'configuration.json'));
    expect(readFileSync(condashSettingsPath(tmp), 'utf8')).toBe(legacyContent);
  });

  it('prefers condash.json over configuration.json when both exist', async () => {
    writeFileSync(join(tmp, 'condash.json'), '{"src":"cd"}\n');
    writeFileSync(join(tmp, 'configuration.json'), '{"src":"cf"}\n');
    const result = await migrateLegacyConfig(tmp);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(join(tmp, 'condash.json'));
    expect(readFileSync(condashSettingsPath(tmp), 'utf8')).toBe('{"src":"cd"}\n');
    // configuration.json is left untouched — only the source of the
    // migration becomes a tombstone.
    expect(readFileSync(join(tmp, 'configuration.json'), 'utf8')).toBe('{"src":"cf"}\n');
  });

  it('skips already-tombstoned legacy files when probing', async () => {
    writeFileSync(
      join(tmp, 'condash.json'),
      JSON.stringify({ _moved_to: `${CONDASH_DIR}/settings.json` }, null, 2),
    );
    writeFileSync(join(tmp, 'configuration.json'), '{"foo":"bar"}\n');
    const result = await migrateLegacyConfig(tmp);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(join(tmp, 'configuration.json'));
    expect(readFileSync(condashSettingsPath(tmp), 'utf8')).toBe('{"foo":"bar"}\n');
  });

  it('appends .condash/ to .gitignore when the conception is a git repo', async () => {
    makeGitRepo();
    writeFileSync(join(tmp, 'condash.json'), '{}\n');
    const result = await migrateLegacyConfig(tmp);
    expect(result.gitignoreUpdated).toBe(true);
    const gitignore = readFileSync(join(tmp, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/\.condash\//);
  });

  it('does not touch .gitignore in a non-git folder', async () => {
    writeFileSync(join(tmp, 'condash.json'), '{}\n');
    const result = await migrateLegacyConfig(tmp);
    expect(result.gitignoreUpdated).toBe(false);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
  });

  it('is idempotent — re-running after a successful migration is a no-op', async () => {
    writeFileSync(join(tmp, 'condash.json'), '{"foo":"bar"}\n');
    await migrateLegacyConfig(tmp);
    const result = await migrateLegacyConfig(tmp);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('primary-already-exists');
  });
});

describe('ensureGitignoreEntry', () => {
  it('creates .gitignore with the .condash/ block when the file is absent', async () => {
    makeGitRepo();
    const updated = await ensureGitignoreEntry(tmp);
    expect(updated).toBe(true);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf8')).toMatch(/\.condash\//);
  });

  it('appends the block when .gitignore exists but lacks the pattern', async () => {
    makeGitRepo();
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n');
    const updated = await ensureGitignoreEntry(tmp);
    expect(updated).toBe(true);
    const text = readFileSync(join(tmp, '.gitignore'), 'utf8');
    expect(text).toMatch(/node_modules\//);
    expect(text).toMatch(/\.condash\//);
  });

  it.each([
    '.condash/\n',
    '.condash\n',
    '/.condash/\n',
    '/.condash\n',
    'node_modules/\n.condash/\nfoo\n',
    '# comment\n.condash/*\n',
  ])('is a no-op when an existing line covers .condash (%j)', async (existing) => {
    makeGitRepo();
    writeFileSync(join(tmp, '.gitignore'), existing);
    const updated = await ensureGitignoreEntry(tmp);
    expect(updated).toBe(false);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf8')).toBe(existing);
  });

  it('returns false (no mutation) when the directory is not a git repo', async () => {
    const updated = await ensureGitignoreEntry(tmp);
    expect(updated).toBe(false);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
  });

  it('inserts a blank-line separator when the existing file does not end in a newline', async () => {
    makeGitRepo();
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/'); // no trailing newline
    const updated = await ensureGitignoreEntry(tmp);
    expect(updated).toBe(true);
    const text = readFileSync(join(tmp, '.gitignore'), 'utf8');
    expect(text.startsWith('node_modules/\n\n')).toBe(true);
    expect(text).toMatch(/\.condash\//);
  });
});
