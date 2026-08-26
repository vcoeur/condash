/**
 * The logical window every screenshot harness composes against, and the scale
 * it captures at. Shared so the two harnesses cannot drift apart — the height
 * is load-bearing (see `screenshots.spec.ts`'s header) and `ui-revamp-shots`
 * documents itself as mirroring it.
 *
 * Height is picked from measurement, not taste: the Projects stack's lanes are
 * separated by 40px of bare background, and this height lands the stack's fold
 * inside one of those gaps so no status lane is published bisected.
 * `requireNoBisectedLane()` enforces that rather than trusting the number.
 */
export const VIEWPORT = { width: 1600, height: 1250 };
export const DEVICE_SCALE = 2;
