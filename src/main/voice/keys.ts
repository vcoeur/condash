// Provider-key resolution for the voice adapter.
//
// Contract (agentsconf): `~/.config/agents/.env` is the machine's one
// secret-bearing file. condash reads it **read-only** and treats it as the
// default source for the STT/TTS provider keys; the per-machine
// `settings.json` `voice.openrouterApiKey` / `voice.mistralApiKey` fields are
// the manual fallback for machines without the env file. Key values are never
// logged and never sent to the renderer.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VoicePrefs } from '../../shared/types';

/** Env-var names looked up in the agents env file. */
export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';
export const MISTRAL_ENV_KEY = 'MISTRAL_API_KEY';

/**
 * Path of the agents env file. Mirrors the `user-scope-paths.ts` convention:
 * a `CONDASH_AGENTS_ENV` override (used by tests) over
 * `~/.config/agents/.env`.
 */
export function agentsEnvPath(): string {
  return process.env.CONDASH_AGENTS_ENV ?? join(homedir(), '.config', 'agents', '.env');
}

/**
 * Parse `.env`-shaped text into a key→value map. Handles `KEY=VALUE`,
 * `export KEY=VALUE`, single/double-quoted values, `#` comments and blank
 * lines. Malformed lines are skipped, never thrown — a half-written env
 * file must not take the whole dictation feature down.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    // Strip one matching layer of surrounding quotes (single or double).
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

/** Read one key from the agents env file. Missing file / missing key /
 *  unreadable file → undefined; this reader never throws. */
export function readAgentEnvKey(name: string, path: string = agentsEnvPath()): string | undefined {
  try {
    const parsed = parseEnvFile(readFileSync(path, 'utf8'));
    const value = parsed[name];
    return value && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The resolved key pair the adapter runs with. Values are opaque secrets:
 *  log nothing derived from them. */
export interface ResolvedVoiceKeys {
  openrouter?: string;
  mistral?: string;
}

/**
 * Resolve the provider keys for one adapter call. Precedence is the brief's
 * contract: the agents env file is the default source; a settings.json value
 * is the manual fallback consulted only when the env file (or the key in it)
 * is missing.
 */
export function resolveVoiceKeys(
  prefs: VoicePrefs | undefined,
  path: string = agentsEnvPath(),
): ResolvedVoiceKeys {
  return {
    openrouter: readAgentEnvKey(OPENROUTER_ENV_KEY, path) ?? prefs?.openrouterApiKey ?? undefined,
    mistral: readAgentEnvKey(MISTRAL_ENV_KEY, path) ?? prefs?.mistralApiKey ?? undefined,
  };
}
