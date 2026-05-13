import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conceptionConfigWritePath,
  readConceptionConfigRaw,
  resolveConceptionConfigPath,
} from './effective-config';
import { CONDASH_DIR, condashSettingsPath } from './condash-dir';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-eff-cfg-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveConceptionConfigPath', () => {
  it('returns .condash/settings.json when it exists', async () => {
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(condashSettingsPath(tmp));
  });

  it('falls back to condash.json when the primary is absent', async () => {
    writeFileSync(join(tmp, 'condash.json'), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(join(tmp, 'condash.json'));
  });

  it('falls back to configuration.json when only the legacy² file exists', async () => {
    writeFileSync(join(tmp, 'configuration.json'), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(join(tmp, 'configuration.json'));
  });

  it('returns the new canonical path for an empty conception (caller may seed)', async () => {
    expect(await resolveConceptionConfigPath(tmp)).toBe(condashSettingsPath(tmp));
  });

  it('prefers .condash/settings.json over both legacies when all three are present', async () => {
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), '{}\n');
    writeFileSync(join(tmp, 'condash.json'), '{}\n');
    writeFileSync(join(tmp, 'configuration.json'), '{}\n');
    expect(await resolveConceptionConfigPath(tmp)).toBe(condashSettingsPath(tmp));
  });
});

describe('conceptionConfigWritePath', () => {
  it('always returns the new canonical path', () => {
    expect(conceptionConfigWritePath(tmp)).toBe(condashSettingsPath(tmp));
  });
});

describe('readConceptionConfigRaw', () => {
  it('returns the parsed primary when present', async () => {
    mkdirSync(join(tmp, CONDASH_DIR));
    writeFileSync(condashSettingsPath(tmp), '{"workspace_path":"/x"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ workspace_path: '/x' });
  });

  it('falls back to condash.json when primary missing', async () => {
    writeFileSync(join(tmp, 'condash.json'), '{"foo":"bar"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ foo: 'bar' });
  });

  it('falls back to configuration.json when condash.json is missing', async () => {
    writeFileSync(join(tmp, 'configuration.json'), '{"src":"cf"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ src: 'cf' });
  });

  it('treats tombstones as absent and probes further', async () => {
    writeFileSync(
      join(tmp, 'condash.json'),
      JSON.stringify({ _moved_to: `${CONDASH_DIR}/settings.json` }),
    );
    writeFileSync(join(tmp, 'configuration.json'), '{"foo":"bar"}\n');
    expect(await readConceptionConfigRaw(tmp)).toEqual({ foo: 'bar' });
  });

  it('returns {} when nothing is present', async () => {
    expect(await readConceptionConfigRaw(tmp)).toEqual({});
  });
});
