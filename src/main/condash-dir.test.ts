import { describe, expect, it } from 'vitest';
import {
  CONDASH_DIR,
  CONDASH_LOGS_SUBDIR,
  CONDASH_SETTINGS_FILENAME,
  condashDir,
  condashLogsRoot,
  condashSettingsPath,
  isConceptionSettingsPath,
  isTombstone,
  legacyCondashJsonPath,
  legacyConfigurationJsonPath,
} from './condash-dir';

describe('condash-dir helpers', () => {
  const conception = '/tmp/conception';

  it('derives the dotted directory from the conception path', () => {
    expect(condashDir(conception)).toBe(`/tmp/conception/${CONDASH_DIR}`);
  });

  it('derives the new canonical settings path', () => {
    expect(condashSettingsPath(conception)).toBe(
      `/tmp/conception/${CONDASH_DIR}/${CONDASH_SETTINGS_FILENAME}`,
    );
  });

  it('derives the logs root', () => {
    expect(condashLogsRoot(conception)).toBe(
      `/tmp/conception/${CONDASH_DIR}/${CONDASH_LOGS_SUBDIR}`,
    );
  });

  it('derives legacy paths at the conception root', () => {
    expect(legacyCondashJsonPath(conception)).toBe(`/tmp/conception/condash.json`);
    expect(legacyConfigurationJsonPath(conception)).toBe(`/tmp/conception/configuration.json`);
  });
});

describe('isConceptionSettingsPath', () => {
  it('returns true for `.condash/settings.json`', () => {
    expect(isConceptionSettingsPath('/home/alice/conception/.condash/settings.json')).toBe(true);
    expect(isConceptionSettingsPath('/x/.condash/settings.json')).toBe(true);
  });

  it('returns false for the global settings.json (parent dir is not `.condash`)', () => {
    expect(isConceptionSettingsPath('/home/alice/.config/condash/settings.json')).toBe(false);
  });

  it('returns false for other files inside `.condash/`', () => {
    expect(isConceptionSettingsPath('/x/.condash/logs.json')).toBe(false);
  });

  it('returns false for the legacy conception-root files', () => {
    expect(isConceptionSettingsPath('/x/condash.json')).toBe(false);
    expect(isConceptionSettingsPath('/x/configuration.json')).toBe(false);
  });
});

describe('isTombstone', () => {
  it('matches the exact marker set the migrator writes', () => {
    expect(
      isTombstone({
        _: 'Settings moved to .condash/settings.json.',
        _moved_to: '.condash/settings.json',
        _moved_at: '2026-08-22T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(isTombstone({ _moved_to: '.condash/settings.json' })).toBe(true);
  });

  it('does not match an empty object', () => {
    expect(isTombstone({})).toBe(false);
  });

  it('does not match a config that merely uses its own `_`-prefixed keys', () => {
    expect(isTombstone({ _custom: 'mine', _other: 1 })).toBe(false);
    expect(isTombstone({ _moved_to: '.condash/settings.json', workspace_path: '/x' })).toBe(false);
  });
});
