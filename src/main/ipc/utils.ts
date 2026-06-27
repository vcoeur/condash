import { readSettings } from '../settings';

/**
 * Shared decoders for renderer-supplied IPC arguments.
 *
 * The renderer is trusted by convention (it's our own SPA behind the
 * `window.condash` bridge), but each handler still defends in depth against a
 * compromised renderer or a wrong call. These replace the per-handler inline
 * guards (`if (typeof x !== 'string' …) throw`) so the trust boundary is
 * uniform and the duplicated literal error strings collapse to one shape:
 * `<channel>: <what was expected>`.
 */

/** Require a non-empty string, e.g. a path/target argument. */
export function requireNonEmptyString(channel: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${channel}: expected a non-empty string`);
  }
  return value;
}

/** Require a boolean argument. */
export function requireBoolean(channel: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${channel}: expected a boolean`);
  }
  return value;
}

/** Require an array of strings, dropping nothing (the handler sanitises). */
export function requireStringArray(channel: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${channel}: expected an array of strings`);
  }
  return value as string[];
}

/**
 * Like `requireStringArray` but tolerates an absent argument (`undefined` /
 * `null` → `undefined`) and additionally requires every element to be a
 * string. For optional list arguments such as `search`'s `scopes`.
 */
export function requireOptionalStringArray(channel: string, value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const arr = requireStringArray(channel, value);
  if (arr.some((item) => typeof item !== 'string')) {
    throw new Error(`${channel}: expected an array of strings`);
  }
  return arr;
}

/**
 * Require a plain object (non-null, non-array) — a structured IPC request
 * payload the handler then reads fields off. Returns it as a string-keyed
 * record; the handler casts to the concrete request type it expects.
 */
export function requireRecord(channel: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${channel}: expected an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Like `requireRecord` but tolerates an absent argument (`undefined` / `null` →
 * `undefined`), for optional object payloads such as the dashboard settings
 * patch a handler defaults to `{}`.
 */
export function requireOptionalRecord(
  channel: string,
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return requireRecord(channel, value);
}

/**
 * Minimal structural slice of Electron's `IpcMainInvokeEvent` used by the
 * sender guard. Kept structural (no `electron` import) so unit tests can pass
 * a plain object without an Electron runtime.
 */
interface SenderLikeEvent {
  sender: { getType(): string } | null;
  senderFrame: { url: string; parent: unknown } | null;
}

/**
 * Throw unless the invoke event originates from the app's own renderer: the
 * sender must be a `BrowserWindow` webContents (never a `<webview>` guest or
 * devtools contents) and the calling frame must be the top frame loaded from
 * an app origin (the packaged `file://` bundle or the Vite dev server).
 *
 * Defence-in-depth on the IPC trust boundary — a compromised frame inside
 * the PDF `<webview>` (or any future embedded contents) must not be able to
 * drive the privileged handlers even if it somehow reaches `ipcRenderer`.
 * Call it first in every `ipcMain.handle` body.
 */
export function requireMainWindowSender(event: SenderLikeEvent): void {
  const sender = event.sender;
  if (!sender || sender.getType() !== 'window') {
    throw new Error('ipc: sender is not an app window');
  }
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) {
    throw new Error('ipc: sender frame is not the top frame');
  }
  if (!isAppOrigin(frame.url)) {
    throw new Error('ipc: sender frame is not an app origin');
  }
}

/** App origins: the packaged file:// bundle, or the Vite dev/preview server
 * (ports 5600/5601 — see AGENTS.md § Dev ports). The host:port prefix is
 * terminated by `/` so `localhost:56001` can't pass as `localhost:5600`. */
function isAppOrigin(url: string): boolean {
  return (
    url.startsWith('file://') ||
    url === 'http://localhost:5600' ||
    url.startsWith('http://localhost:5600/') ||
    url === 'http://localhost:5601' ||
    url.startsWith('http://localhost:5601/')
  );
}

/**
 * Require the value be one of `allowed`. Returns it narrowed to that union.
 * Used for the small string-enum arguments (theme, skill scope, …).
 */
export function requireEnum<T extends string>(
  channel: string,
  value: unknown,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${channel}: expected one of ${[...allowed].join(' | ')}`);
  }
  return value as T;
}

/**
 * Resolve the active conception path and call `handler` with it. Returns
 * `fallback` when no conception is set. Centralises the
 * `if (!conceptionPath) return …` boilerplate that every conception-scoped
 * handler used to repeat inline.
 */
export async function withConception<T>(
  handler: (conceptionPath: string) => Promise<T> | T,
  fallback: T,
): Promise<T> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) return fallback;
  return handler(conceptionPath);
}

/**
 * Same as `withConception` but throws when no conception is set, for handlers
 * that *require* one (e.g. forceStopRepo). The thrown message is the same
 * inline literal those handlers used before the extraction.
 */
export async function requireConception<T>(
  handler: (conceptionPath: string) => Promise<T> | T,
): Promise<T> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) throw new Error('No conception path set');
  return handler(conceptionPath);
}
