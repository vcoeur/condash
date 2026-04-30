/** localStorage helpers for the bottom terminal pane. Two namespaces:
 *  per-tab metadata (label, custom name, column) and per-pane layout
 *  (pane height, split ratio). Both wrap try/catch around storage access
 *  so a quota-full or sandboxed env doesn't break the renderer. */

import type { Column } from './types';

export interface PersistedTabMeta {
  label: string;
  customName?: string;
  column: Column;
}

export interface PersistedLayout {
  paneHeight: number;
  splitRatio: number;
}

export const META_KEY = 'condash-term-meta';
export const LAYOUT_KEY = 'condash-term-layout';
export const DEFAULT_PANE_HEIGHT = 280;
export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_PANE_HEIGHT = 120;
export const MAX_PANE_HEIGHT_VH = 0.85;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

export function readMeta(): Record<string, PersistedTabMeta> {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PersistedTabMeta>) : {};
  } catch {
    return {};
  }
}

export function writeMeta(meta: Record<string, PersistedTabMeta>): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
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
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}
