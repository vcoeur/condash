export const fixture = {
  sid: '',
  mode: 'live' as 'live' | 'unknown' | 'failed' | 'hold',
  writes: [] as { sid: string; text: string }[],
  requests: [] as {
    url: string;
    model: string;
    rate: number;
    samples: number;
    hints: string[];
    aborted: boolean;
  }[],
  statusReads: 0,
  finalizing: false,
  releases: [] as (() => void)[],
};

// Only terminal edges are replaced. Handler admission, settings snapshots,
// native adapter, segmented session and insertion decisions stay production.
export function listTerminalSessions() {
  return [{ id: fixture.sid }];
}
export function writeTerminal(sid: string, text: string) {
  fixture.writes.push({ sid, text });
}
export function tabRecentText() {
  return 'Synthetic recent output';
}
