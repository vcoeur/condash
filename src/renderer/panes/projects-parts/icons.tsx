import { Match, Switch } from 'solid-js';
import type { StepCounts, StepMarker } from '@shared/types';

/* StepIcon — single shape vocabulary for the five step states. Drawn as a
 * 16×16 SVG so the same component renders the card's next-step marker, the
 * expanded step list in the card, and the popup's step list. Colour comes
 * from `currentColor` so the per-state color tokens cascade through.
 *
 *   ' ' (todo)    → outlined rounded square
 *   '~' (doing)   → outlined square + concentric inner filled square
 *   'x' (done)    → filled square with negative-space check mark
 *   '!' (blocked) → outlined square + bold exclamation glyph
 *   '-' (dropped) → outlined square crossed out
 *
 * Each branch is wrapped in <Match> so the rendered SVG swaps reactively
 * when `props.marker` changes — a plain `if/return` body is evaluated once
 * at mount, leaving the shape frozen on the marker value the component
 * was first created with.
 */
export function StepIcon(props: { marker: StepMarker }) {
  return (
    <Switch
      fallback={
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
        </svg>
      }
    >
      <Match when={props.marker === '~'}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
          <rect
            x="5.75"
            y="5.75"
            width="4.5"
            height="4.5"
            rx="0.75"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      </Match>
      <Match when={props.marker === 'x'}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect
            x="2.5"
            y="2.5"
            width="11"
            height="11"
            rx="2.25"
            fill="currentColor"
            stroke="currentColor"
          />
          <path d="M5.25 8.25l2 2L10.75 6.5" stroke="var(--bg-elevated)" stroke-width="1.8" />
        </svg>
      </Match>
      <Match when={props.marker === '!'}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
          <path d="M8 5v4" stroke-width="1.8" />
          <circle cx="8" cy="11.25" r="0.85" fill="currentColor" stroke="none" />
        </svg>
      </Match>
      <Match when={props.marker === '-'}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
        </svg>
      </Match>
    </Switch>
  );
}

/* Step progress — done and dropped count as "resolved" so the bar fills when
 * every step has been decided one way or the other. Blocked steps count
 * toward the total (they're real milestones still in play) but not toward
 * resolved — a blocked step is unfinished business demanding attention.
 * Reaches 100% when no todo, doing, or blocked steps remain, even if some
 * were dropped along the way. */
export function StepProgress(props: { counts: StepCounts }) {
  const total = (): number =>
    props.counts.todo +
    props.counts.doing +
    props.counts.done +
    props.counts.blocked +
    props.counts.dropped;
  const resolved = (): number => props.counts.done + props.counts.dropped;
  const ratio = (): number => {
    const t = total();
    return t === 0 ? 0 : Math.min(1, resolved() / t);
  };
  const title = (): string =>
    `${props.counts.todo} todo, ${props.counts.doing} doing, ${props.counts.done} done, ${props.counts.blocked} blocked, ${props.counts.dropped} dropped`;
  const isComplete = (): boolean =>
    total() > 0 &&
    props.counts.todo === 0 &&
    props.counts.doing === 0 &&
    props.counts.blocked === 0;

  return (
    <span
      class="step-progress-inner"
      data-complete={isComplete() ? 'true' : undefined}
      title={title()}
    >
      <span class="progress-track">
        <span class="progress-fill" style={{ width: `${ratio() * 100}%` }} />
      </span>
      <span class="progress-text">
        {resolved()}/{total()}
      </span>
    </span>
  );
}

/* Icon system — Projects pane.
 *
 * All icons share a 16×16 viewBox, currentColor stroke, round caps and joins,
 * and a duotone accent (currentColor at fill-opacity 0.16-0.22) inside the
 * stroked silhouette. Stroke weights come from CSS (.title-kind svg vs .meta
 * vs .row-action) so the icons read consistently in every container.
 *
 * Each icon is hand-tuned for its meaning rather than being a stock library
 * glyph — see the comments above each definition. */

const KIND_ICON: Record<string, () => any> = {
  // Project — gem-cut diamond outline with a soft horizontal facet line
  // and a small filled core. Reads as "waypoint with depth" rather than
  // a flat rhombus. Leftmost path point at viewBox x=2.5 to align with
  // the step icon's rect (also x=2.5) and the other kind icons.
  project: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5L13.5 8 8 13.5 2.5 8z" />
      <path d="M5 8h6" stroke-opacity="0.45" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Incident — alert triangle with a soft duotone wash plus a clean
  // exclamation glyph (line + dot). Leftmost path point at x=2.5 (base's
  // bottom-left) to match the rest of the icon set.
  incident: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3L13.5 13.5h-11z" fill="currentColor" fill-opacity="0.18" stroke="currentColor" />
      <path d="M8 6.75v3" />
      <circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Document — page outline with an elegant filled corner-fold (duotone
  // triangle) and two text lines, the second shorter for natural text
  // rhythm. Pretty in a literary, archival way. Leftmost path point
  // at x=2.5, matching the rest of the icon set.
  document: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 2h6L12 5.5v9H2.5z" />
      <path d="M8.5 2L12 5.5h-3.5z" fill="currentColor" fill-opacity="0.28" stroke="currentColor" />
      <path d="M4.75 9h4.5M4.75 11.5h2.75" />
    </svg>
  ),
};

function KindIcon(props: { kind: string }) {
  const Icon = KIND_ICON[props.kind];
  if (!Icon) return null;
  return <Icon />;
}

const KIND_LABEL: Record<string, string> = {
  project: 'Project',
  incident: 'Incident',
  document: 'Document',
};

/* Kind glyph — small tinted-tile icon that marks a card or modal with
 * its kind (project / incident / document). No text label: the icon
 * carries the meaning (helped by the `aria-label` and `title` for screen
 * readers and tooltips). Sits at the start of the title in cards and
 * inline in the popup's metadata row. */
export function KindGlyph(props: { kind: string }) {
  if (!KIND_ICON[props.kind]) return null;
  return (
    <span
      class="kind-glyph"
      data-kind={props.kind}
      title={KIND_LABEL[props.kind]}
      aria-label={KIND_LABEL[props.kind]}
    >
      <KindIcon kind={props.kind} />
    </span>
  );
}

// Unknown-status warning — circle with a duotone wash, a bold short
// vertical bar, and a slightly larger dot below. Reads cleanly at 12 px.
export function WarnIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" fill="currentColor" fill-opacity="0.14" />
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.75v3.75" />
      <circle cx="8" cy="11.25" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}
