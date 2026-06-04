/** localStorage helpers for the bottom terminal pane. Two namespaces:
 *  per-tab metadata (label, custom name, column) and per-pane layout
 *  (pane height, split ratio). Both wrap try/catch around storage access
 *  so a quota-full or sandboxed env doesn't break the renderer. */

import type { Column } from './types';

export interface PersistedTabMeta {
  label: string;
  customName?: string;
  column: Column;
  /** Palette slot (0..TAB_COLOR_SLOT_COUNT-1) frozen onto the tab at
   *  creation. Persisted so the colour survives restarts and never shifts
   *  when other tabs are closed or reordered. */
  colorSlot?: number;
  /** When true, `displayName` ignores OSC 7 cwd updates and keeps `label`
   *  (unless `customName` is set). Pinned at spawn time by launchers that
   *  supply a deliberate title — lambda button, code-card "open in term".
   *  The "+" new-shell path leaves this falsy so cwd basename wins. */
  pinned?: boolean;
}

export interface PersistedLayout {
  paneHeight: number;
  splitRatio: number;
}

// Versioned, namespaced keys: a future schema bump can move to `-v2`
// without stomping on the previous shape (and the previous shape stays
// readable in case we ever need a one-shot migration). Bumping a key here
// is the migration trigger — old keys are left in place to be GC'd.
export const META_KEY = 'condash:term:meta:v1';
export const LAYOUT_KEY = 'condash:term:layout:v1';
// Monotonic colour-sequence counter. Each new tab consumes one tick; the
// slot is derived from it, then frozen onto the tab. Persisted so the zebra
// keeps advancing across restarts instead of resetting to red every launch.
export const COLORSEQ_KEY = 'condash:term:colorseq:v1';
// Mirrors the app-pill palette length in `panes/app-pill.css` (slots 0..19).
export const TAB_COLOR_SLOT_COUNT = 20;
// Stride between consecutive tabs' slots. Coprime with the slot count, so the
// sequence visits every hue once before repeating and adjacent tabs land far
// apart on the wheel (red → chartreuse → indigo → …) for clear alternation.
const COLOR_SLOT_STRIDE = 7;
export const DEFAULT_PANE_HEIGHT = 280;
export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_PANE_HEIGHT = 120;
export const MAX_PANE_HEIGHT_VH = 0.85;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

// Drag-driven writes (resize, splitter) used to call writeLayout per
// mousemove tick. localStorage writes are sync and serialise the renderer;
// 60 fps × 2 keys × N panes adds up. Coalesce to one write per key per
// 250 ms — far below the user's perceived persistence latency.
const WRITE_DEBOUNCE_MS = 250;
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, string>();

function scheduleWrite(key: string, payload: string): void {
  pendingValues.set(key, payload);
  if (pendingWrites.has(key)) return;
  const t = setTimeout(() => {
    pendingWrites.delete(key);
    const value = pendingValues.get(key);
    pendingValues.delete(key);
    if (value === undefined) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore quota / sandboxed env */
    }
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(key, t);
}

// Force any pending writes to flush synchronously. Wired to `pagehide` so a
// quit/close doesn't lose the last 250 ms of layout edits.
function flushPersistence(): void {
  for (const [key, t] of pendingWrites) {
    clearTimeout(t);
    const value = pendingValues.get(key);
    if (value !== undefined) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    }
  }
  pendingWrites.clear();
  pendingValues.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersistence);
}

export function readMeta(): Record<string, PersistedTabMeta> {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PersistedTabMeta>) : {};
  } catch {
    return {};
  }
}

function writeMeta(meta: Record<string, PersistedTabMeta>): void {
  scheduleWrite(META_KEY, JSON.stringify(meta));
}

export function setMeta(id: string, value: PersistedTabMeta): void {
  const map = readMeta();
  map[id] = value;
  writeMeta(map);
}

export function deleteMeta(id: string): void {
  const map = readMeta();
  delete map[id];
  writeMeta(map);
}

/** Allocate the next creation-time colour slot. Reads + bumps the persisted
 *  monotonic counter (written synchronously so back-to-back spawns don't all
 *  collide on the same slot) and maps it onto the palette via the coprime
 *  stride. Falls back to slot 0 if storage is unavailable. */
export function allocateColorSlot(): number {
  let seq = 0;
  try {
    const raw = localStorage.getItem(COLORSEQ_KEY);
    seq = raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch {
    /* sandboxed env — start the sequence from 0 */
  }
  const slot = (seq * COLOR_SLOT_STRIDE) % TAB_COLOR_SLOT_COUNT;
  try {
    localStorage.setItem(COLORSEQ_KEY, String(seq + 1));
  } catch {
    /* ignore quota / sandboxed env */
  }
  return slot;
}

export function readLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { paneHeight: DEFAULT_PANE_HEIGHT, splitRatio: DEFAULT_SPLIT_RATIO };
    const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
    return {
      paneHeight: typeof parsed.paneHeight === 'number' ? parsed.paneHeight : DEFAULT_PANE_HEIGHT,
      splitRatio: typeof parsed.splitRatio === 'number' ? parsed.splitRatio : DEFAULT_SPLIT_RATIO,
    };
  } catch {
    return { paneHeight: DEFAULT_PANE_HEIGHT, splitRatio: DEFAULT_SPLIT_RATIO };
  }
}

export function writeLayout(layout: PersistedLayout): void {
  scheduleWrite(LAYOUT_KEY, JSON.stringify(layout));
}
