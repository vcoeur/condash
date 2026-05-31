/** Schedule-cadence parsing for the task scheduler (capability 1). Pure +
 *  dependency-free so it can be unit-tested without the Electron main graph. */

/** Parse a cadence string (`30s`, `2m`, `1h`) to milliseconds. Returns null
 *  when the string is absent or malformed — the task is then treated as not
 *  scheduled. Whitespace around the unit is tolerated; the count must be a
 *  positive integer. */
export function parseCadence(spec: string | undefined): number | null {
  if (!spec) return null;
  const m = /^(\d+)\s*(s|m|h)$/.exec(spec.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  const factor = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return n * factor;
}
