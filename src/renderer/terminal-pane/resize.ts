import type { Setter } from 'solid-js';
import type { FitAddon } from '@xterm/addon-fit';
import {
  MAX_PANE_HEIGHT_VH,
  MAX_SPLIT_RATIO,
  MIN_PANE_HEIGHT,
  MIN_SPLIT_RATIO,
  writeLayout,
} from './persistence';

export interface ResizeDeps {
  paneHeight: () => number;
  setPaneHeight: Setter<number>;
  splitRatio: () => number;
  setSplitRatio: Setter<number>;
  /** Iterable of every live xterm `FitAddon` — re-fitted on every drag tick
   *  so the canvas tracks the dragged divider in real time. */
  fitAddons: () => Iterable<FitAddon>;
}

/** Splitter + height drag handlers + window-resize listener for the
 *  bottom terminal pane. Ratio + height are persisted to localStorage on
 *  drag-end. Each drag installs window-level move/up listeners that clean
 *  up after themselves. */
export function createResizeHandlers(deps: ResizeDeps): {
  startSplitterDrag: (e: MouseEvent, container: HTMLElement) => void;
  startHeightDrag: (e: MouseEvent) => void;
  onWindowResize: () => void;
} {
  const refit = (): void => {
    for (const fit of deps.fitAddons()) {
      try {
        // fit() only calls term.resize() when the computed cols/rows actually
        // change, and term.onResize (→ termResize IPC) fires only on a real
        // change — so an unchanged drag tick sends no pty resize.
        fit.fit();
      } catch {
        /* not yet sized */
      }
    }
  };

  // Coalesce the per-mousemove refit to one call per animation frame: a splitter
  // drag fires mousemove far faster than 60 fps, and each fit() measures char
  // cells (a layout read). The signal-driven CSS resize still tracks the pointer
  // synchronously; only the xterm canvas fit is throttled to the frame.
  let refitRaf: number | null = null;
  const scheduleRefit = (): void => {
    if (refitRaf !== null) return;
    refitRaf = requestAnimationFrame(() => {
      refitRaf = null;
      refit();
    });
  };
  const cancelScheduledRefit = (): void => {
    if (refitRaf === null) return;
    cancelAnimationFrame(refitRaf);
    refitRaf = null;
  };

  const persist = (): void => {
    writeLayout({ paneHeight: deps.paneHeight(), splitRatio: deps.splitRatio() });
  };

  const startSplitterDrag = (startEvent: MouseEvent, container: HTMLElement): void => {
    if (startEvent.button !== 0) return;
    startEvent.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (e: MouseEvent) => {
      const ratio = (e.clientX - rect.left) / rect.width;
      const clamped = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
      deps.setSplitRatio(clamped);
      scheduleRefit();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Settle the final size exactly, dropping any frame still pending.
      cancelScheduledRefit();
      refit();
      persist();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startHeightDrag = (startEvent: MouseEvent): void => {
    if (startEvent.button !== 0) return;
    startEvent.preventDefault();
    const startY = startEvent.clientY;
    const startHeight = deps.paneHeight();
    const maxHeight = Math.floor(window.innerHeight * MAX_PANE_HEIGHT_VH);
    const onMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const next = Math.max(MIN_PANE_HEIGHT, Math.min(maxHeight, startHeight + delta));
      deps.setPaneHeight(next);
      scheduleRefit();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Settle the final size exactly, dropping any frame still pending.
      cancelScheduledRefit();
      refit();
      persist();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return { startSplitterDrag, startHeightDrag, onWindowResize: refit };
}
