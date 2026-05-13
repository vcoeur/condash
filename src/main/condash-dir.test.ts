import { describe, expect, it } from 'vitest';
import {
  CONDASH_DIR,
  CONDASH_LOGS_SUBDIR,
  CONDASH_SETTINGS_FILENAME,
  condashDir,
  condashLogsRoot,
  condashSettingsPath,
  isConceptionSettingsPath,
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
