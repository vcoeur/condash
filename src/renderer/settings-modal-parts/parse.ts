import type { RawConfig } from './data';

/** Parse `text` as a `RawConfig`. Empty string and parse failures fall
 *  back to an empty object — the live editor still mounts so the user
 *  can repair the file. */
export function parseRawConfig(text: string): RawConfig {
  if (!text) return {};
  try {
    return JSON.parse(text) as RawConfig;
  } catch {
    return {};
  }
}

/** Surface a JSON parse error message for `text`. Returns null when the
 *  text is empty (file doesn't exist yet) or parses cleanly. */
export function parseErrorOf(text: string): string | null {
  if (!text) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
