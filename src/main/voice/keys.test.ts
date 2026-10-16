import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPENROUTER_ENV_KEY,
  parseEnvFile,
  readAgentEnvKey,
  resolveVoiceKeys,
  voiceCredentialStatus,
} from './keys';

const SETTINGS_PREFS = {
  openrouterApiKey: 'settings-openrouter',
  mistralApiKey: 'settings-mistral',
};

let dir: string | undefined;
function envFile(content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'condash-voice-keys-'));
  const path = join(dir, '.env');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('parseEnvFile', () => {
  it('parses KEY=VALUE, ignores comments and blanks', () => {
    expect(parseEnvFile('# c\n\nA=1\nB=two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('handles export prefixes and quotes', () => {
    expect(
      parseEnvFile('export A="quoted value"\nB=\'single\'\nC=plain#not-comment-inside'),
    ).toEqual({ A: 'quoted value', B: 'single', C: 'plain#not-comment-inside' });
  });

  it('skips malformed lines without throwing', () => {
    expect(parseEnvFile('NO_EQUALS\n=NOKEY\n1BAD=2\nGOOD=ok')).toEqual({ GOOD: 'ok' });
  });
});

describe('readAgentEnvKey', () => {
  it('returns the key value when present', () => {
    expect(readAgentEnvKey(OPENROUTER_ENV_KEY, envFile('OPENROUTER_API_KEY=abc123'))).toBe(
      'abc123',
    );
  });

  it('returns undefined for a missing key in an existing file', () => {
    expect(readAgentEnvKey('NOT_THERE', envFile('OTHER=x'))).toBeUndefined();
  });

  it('returns undefined for a missing file (never throws)', () => {
    expect(
      readAgentEnvKey(OPENROUTER_ENV_KEY, join(dir ?? tmpdir(), 'absent.env')),
    ).toBeUndefined();
  });
});

describe('resolveVoiceKeys', () => {
  it('describes quoted/blank env entries with the same precedence and no key material', () => {
    const path = envFile('OPENROUTER_API_KEY=" env-secret "\nMISTRAL_API_KEY="  "\n');
    expect(resolveVoiceKeys(SETTINGS_PREFS, path)).toEqual({
      openrouter: 'env-secret',
      mistral: 'settings-mistral',
    });
    expect(voiceCredentialStatus(SETTINGS_PREFS, path)).toEqual({
      openrouter: { present: true, source: 'agents-env' },
      mistral: { present: true, source: 'settings' },
    });
    expect(voiceCredentialStatus(undefined, dir)).toEqual({
      openrouter: { present: false, source: 'none' },
      mistral: { present: false, source: 'none' },
    });
  });
  it('prefers the env file over the settings fallback', () => {
    const path = envFile('OPENROUTER_API_KEY=env-or\nMISTRAL_API_KEY=env-mi');
    expect(resolveVoiceKeys(SETTINGS_PREFS, path)).toEqual({
      openrouter: 'env-or',
      mistral: 'env-mi',
    });
  });

  it('falls back to the settings value when the env key is missing', () => {
    const path = envFile('OPENROUTER_API_KEY=env-or');
    expect(resolveVoiceKeys(SETTINGS_PREFS, path)).toEqual({
      openrouter: 'env-or',
      mistral: 'settings-mistral',
    });
  });

  it('falls back to settings for both when the file is missing', () => {
    expect(resolveVoiceKeys(SETTINGS_PREFS, join(tmpdir(), 'definitely-absent.env'))).toEqual({
      openrouter: 'settings-openrouter',
      mistral: 'settings-mistral',
    });
  });

  it('returns an empty pair when nothing is configured anywhere', () => {
    expect(resolveVoiceKeys(undefined, join(tmpdir(), 'absent.env'))).toEqual({});
  });
});
