/**
 * README / note mutation barrel. The mutation families were split into
 * cohesive modules so each is independently testable and the generic note
 * writer no longer drags config-schema knowledge into the step/status code:
 *
 *   - `mutate-steps.ts`   — `## Steps` checklist editing.
 *   - `mutate-status.ts`  — **Status** transitions + `## Timeline` editing.
 *   - `write-config.ts`   — generic note write + settings/config canonicalisation.
 *   - `mutate-shared.ts`  — the line-ending + per-file-queue text toolkit.
 *
 * This barrel re-exports the public surface so existing `./mutate` importers
 * keep working unchanged.
 */
export { toggleStep, editStepText, addStep } from './mutate-steps';
export {
  transitionStatus,
  appendTimelineEntry,
  parseTimelineEntries,
  CLOSED_LINE,
  type TransitionOpts,
  type TransitionResult,
} from './mutate-status';
export { writeNote } from './write-config';
