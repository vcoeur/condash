/** Parsed keyboard shortcut. Use `parseShortcut` to build one and
 *  `matchesShortcut` to test a `KeyboardEvent` against it. */
export interface Shortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

/** Parse a `Ctrl+Shift+P`-style spec. Returns null when the spec is empty
 *  or has no key portion. Aliases: Control=Ctrl, Option=Alt, Cmd/Super=Meta. */
export function parseShortcut(spec: string | undefined): Shortcut | null {
  if (!spec) return null;
  const parts = spec
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out: Shortcut = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') out.ctrl = true;
    else if (lower === 'shift') out.shift = true;
    else if (lower === 'alt' || lower === 'option') out.alt = true;
    else if (lower === 'cmd' || lower === 'meta' || lower === 'super') out.meta = true;
    else out.key = part.length === 1 ? part.toLowerCase() : part;
  }
  return out.key ? out : null;
}

/** Test whether a keydown matches a parsed shortcut. */
export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut | null): boolean {
  if (!shortcut) return false;
  if (shortcut.ctrl !== event.ctrlKey) return false;
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;
  if (shortcut.meta !== event.metaKey) return false;
  const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return eventKey === shortcut.key;
}
