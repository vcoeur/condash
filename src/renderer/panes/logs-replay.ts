/**
 * Walk a session's events and group contiguous `out` chunks into one
 * rendered transcript via a `ReplaySegmentRenderer`. Non-`out` events
 * (in / spawn / exit / rotate) seal the current transcript and pass
 * through as event items.
 *
 * The renderer is injected so the orchestration is testable without a
 * DOM. Production wires this against xterm.js's `Terminal` +
 * `SerializeAddon`; tests use a string-concatenation stub.
 *
 * Why split at non-`out` boundaries: a session that interleaves `in`
 * keystrokes with shell output (shell run) is naturally multi-segment —
 * each "between-keystrokes" run of program output renders into its own
 * terminal, so each block reflects the screen state at that boundary.
 * For sessions with no `in` events (e.g. a long-running TUI like Claude
 * Code) the whole `out` stream collapses into one transcript.
 */

import type { TermLogEvent } from '@shared/types';

export interface ReplaySegmentRenderer {
  /** Begin a fresh segment — disposes any prior segment's resources. */
  start(): void;
  /** Feed raw PTY bytes into the current segment. */
  write(data: string): void;
  /** Read the current segment's rendered text. Awaits any pending parse. */
  serialize(): Promise<string>;
  /** Tear down the renderer entirely. Called once at the end of the walk. */
  dispose(): void;
}

export type RenderedItem =
  | { kind: 'event'; ev: TermLogEvent; idx: number }
  | { kind: 'transcript'; text: string; firstTs: string; segmentId: number };

export async function buildRenderedItems(
  events: readonly TermLogEvent[],
  renderer: ReplaySegmentRenderer,
): Promise<RenderedItem[]> {
  const items: RenderedItem[] = [];
  let inSegment = false;
  let segmentStartTs = '';
  let segmentId = 0;

  const flushSegment = async (): Promise<void> => {
    if (!inSegment) return;
    const text = await renderer.serialize();
    items.push({ kind: 'transcript', text, firstTs: segmentStartTs, segmentId });
    segmentId += 1;
    inSegment = false;
    segmentStartTs = '';
  };

  for (let idx = 0; idx < events.length; idx += 1) {
    const ev = events[idx];
    if (ev.kind === 'out') {
      if (typeof ev.data !== 'string') continue;
      if (!inSegment) {
        renderer.start();
        inSegment = true;
        segmentStartTs = ev.ts;
      }
      renderer.write(ev.data);
    } else {
      await flushSegment();
      items.push({ kind: 'event', ev, idx });
    }
  }
  await flushSegment();
  renderer.dispose();
  return items;
}

/** Substring-searchable form of a rendered item — same canonicalisation
 * the row renders, used by the Logs pane's filter. */
export function searchableText(item: RenderedItem): string {
  if (item.kind === 'transcript') return item.text;
  const ev = item.ev;
  if (ev.kind === 'spawn') {
    const argv = Array.isArray(ev.argv) ? ev.argv.join(' ') : '';
    return `${ev.cmd ?? ''} ${argv}`.trim();
  }
  if (ev.kind === 'in' || ev.kind === 'out') return ev.text ?? '';
  if (ev.kind === 'exit') return `exitCode=${ev.exitCode ?? '?'}`;
  if (ev.kind === 'rotate') return `rotated from ${ev.from ?? ''} to ${ev.to ?? ''}`;
  return '';
}
