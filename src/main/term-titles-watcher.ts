/**
 * Standalone watcher for `<conception>/.condash/term-titles.json` (capability
 * 3 — watch + apply). Deliberately *not* folded into the conception-tree
 * watcher (`watcher.ts`): that watcher ignores dotfile segments (`.condash/`),
 * fires `tree-events` (which trigger full tree rebuilds), and classifying a
 * `.condash/` file there would couple title-apply to project/knowledge
 * reconciliation. This one watches a single file and broadcasts a dedicated
 * `termAutoTitles` event carrying the validated `{sid, title}` list. The
 * renderer sparse-merges them onto its tabs (unknown sids ignored, omitted
 * sids left untouched) — see `terminal-pane.tsx`.
 *
 * Atomic writes (tmp + rename) by the producing task pair with chokidar's
 * `awaitWriteFinish` so a watcher never reads a half-file.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import type { TermAutoTitle } from '../shared/types';
import { readTermTitles, termTitlesPath } from './term-titles';

const DEBOUNCE_MS = 150;

let current: { path: string; watcher: FSWatcher } | null = null;
let timer: NodeJS.Timeout | null = null;

function broadcast(titles: TermAutoTitle[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send('termAutoTitles', titles);
  }
}

/** Read the current file and push its validated titles to every window. */
async function applyNow(conceptionPath: string): Promise<void> {
  broadcast(await readTermTitles(conceptionPath));
}

function schedule(conceptionPath: string): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void applyNow(conceptionPath);
  }, DEBOUNCE_MS);
}

/**
 * Point the term-titles watcher at `conceptionPath` (or tear it down with
 * `null`). Idempotent for the same path. Does an immediate apply on setup so a
 * conception opened with a pre-existing file paints its titles without waiting
 * for the next write.
 */
export async function setWatchedTermTitles(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;
  if (current) {
    await current.watcher.close().catch(() => undefined);
    current = null;
  }
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!conceptionPath) return;

  const file = termTitlesPath(conceptionPath);
  const watcher = chokidar.watch(file, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  watcher.on('add', () => schedule(conceptionPath));
  watcher.on('change', () => schedule(conceptionPath));
  // unlink → broadcast empty so nothing new is applied; existing titles are
  // left in place on the renderer (we never wipe), matching the sparse-merge
  // contract. No-op broadcast is harmless.
  watcher.on('error', (err) => console.error('[term-titles-watcher]', err));

  current = { path: conceptionPath, watcher };
  // Best-effort initial apply (the renderer also pulls via termAutoTitlesList
  // on mount, covering the case where no window exists yet at boot).
  void applyNow(conceptionPath);
}
