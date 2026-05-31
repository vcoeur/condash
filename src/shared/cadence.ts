/** Schedule-cadence parsing for the task scheduler (capability 1). Pure +
 *  dependency-free so it can be unit-tested without the Electron main graph. */

/** Parse a cadence string (`30s`, `2m`, `1h`, `7d`) to milliseconds. Returns
 *  null when the string is absent or malformed — the task is then treated as
 *  not scheduled. Whitespace around the unit is tolerated; the count must be a
 *  positive integer. Used for both the schedule cadence and the per-task run
 *  timeout. */
export function parseCadence(spec: string | undefined): number | null {
  if (!spec) return null;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(spec.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const factor: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * factor[m[2]];
}
