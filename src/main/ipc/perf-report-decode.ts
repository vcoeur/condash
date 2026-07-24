/**
 * Decoder for the renderer's perf report.
 *
 * The payload crosses the IPC trust boundary and then lands in a file that gets
 * read back as evidence, so a malformed field must be rejected rather than
 * recorded: a `NaN` or an `Infinity` in one report would poison the merged
 * maxima for the whole window and, once written, be indistinguishable from a
 * measurement. Kept free of any `electron` import so it is unit-testable on its
 * own.
 */

import type { RendererPerfReport } from '../../shared/types';

/** A finite, non-negative number, or undefined for anything else. */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Decode the `{name: {ms, n}}` span map, dropping malformed entries. */
function decodeSpans(value: unknown): Record<string, { ms: number; n: number }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, { ms: number; n: number }> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const ms = finiteNonNegative((raw as { ms?: unknown }).ms);
    const n = finiteNonNegative((raw as { n?: unknown }).n);
    if (ms === undefined || n === undefined) continue;
    out[name] = { ms, n };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Decode a `{name: number}` map (counters, peaks), dropping malformed
 *  entries. */
function decodeCounts(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = finiteNonNegative(raw);
    if (count !== undefined) out[name] = count;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a renderer perf report.
 *
 * @param value The raw IPC payload.
 * @returns The report, or null when the required fields are missing or not
 *   finite non-negative numbers. Optional maps are pruned entry by entry — one
 *   bad span never discards a whole window's loop figures.
 */
export function decodeRendererReport(value: unknown): RendererPerfReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const windowMs = finiteNonNegative(raw.windowMs);
  const samples = finiteNonNegative(raw.samples);
  const hiddenMs = finiteNonNegative(raw.hiddenMs);
  const frames = finiteNonNegative(raw.frames);
  const longFrames = finiteNonNegative(raw.longFrames);
  const frameMaxMs = finiteNonNegative(raw.frameMaxMs);
  const loopRaw = raw.loop;
  if (typeof loopRaw !== 'object' || loopRaw === null) return null;
  const loop = loopRaw as Record<string, unknown>;
  const p50 = finiteNonNegative(loop.p50);
  const p99 = finiteNonNegative(loop.p99);
  const max = finiteNonNegative(loop.max);
  if (
    windowMs === undefined ||
    samples === undefined ||
    hiddenMs === undefined ||
    frames === undefined ||
    longFrames === undefined ||
    frameMaxMs === undefined ||
    p50 === undefined ||
    p99 === undefined ||
    max === undefined
  ) {
    return null;
  }
  const spans = decodeSpans(raw.spans);
  const counts = decodeCounts(raw.counts);
  const maxima = decodeCounts(raw.maxima);
  return {
    windowMs,
    loop: { p50, p99, max },
    samples,
    hiddenMs,
    frames,
    longFrames,
    frameMaxMs,
    ...(spans ? { spans } : {}),
    ...(counts ? { counts } : {}),
    ...(maxima ? { maxima } : {}),
  };
}
