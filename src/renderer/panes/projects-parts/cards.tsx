import { createSignal, For, Show } from 'solid-js';
import type { ActionTemplate, Project, Step } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';
import { appColorClass } from '@shared/app-color';
import { TerminalIcon } from '../../icons';
import { ActionDropdownButton } from '../../action-dropdown-button';
import {
  Group,
  MARKER_LABEL,
  dateRangeLabel,
  firstDate,
  hasSteps,
  isStepCountsComplete,
  lastDate,
  markerClass,
  nextMarker,
  nextOpenStep,
  readCollapseMap,
  writeCollapseEntry,
} from './data';
import { KindGlyph, StepIcon, StepProgress, WarnIcon } from './icons';

// Status lane the pointer currently hovers during a card drag (null = none).
// Module scope so every GroupBlock highlights its lane reactively while the
// dragged Card drives the gesture, without threading a signal through props.
const [overStatus, setOverStatus] = createSignal<string | null>(null);

// Movement past this many pixels turns a press into a drag — below it the
// press stays a click so cards still open on a plain click.
const DRAG_THRESHOLD_PX = 4;

export function GroupBlock(props: {
  group: Group;
  /** When true, the section starts collapsed and shows an expand affordance. */
  collapsedByDefault?: boolean;
  /** Override collapsed state — e.g. when a search filter is active and the
   * group has matches, force it open so results aren't hidden. */
  forceOpen?: boolean;
  /** Optional body override. When provided, replaces the default cards loop
   * — used by the Done section to render per-month subgroups instead of a
   * flat card list. The outer header / collapse / drag-drop chrome is
   * unchanged. */
  bodySlot?: () => any;
  /** Optional trailing element rendered inside the header row, right of the
   * count. Used by the NOW section to surface the "+ New project" button on
   * the same row as the section title (saves a row of vertical space and
   * anchors the affordance to the section it acts on). The slot's click is
   * stopped from propagating so it doesn't toggle the section. */
  headerAction?: () => any;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
  onWorkOn: (project: Project) => void;
  projectActions?: ActionTemplate[];
  onProjectAction?: (project: Project, action: ActionTemplate) => void;
}) {
  // Keyboard alternative for the status drag — same callback as the drop,
  // signature `(path, newStatus)`, so cards can call it directly.
  const onChangeStatus = props.onDropProject;
  const initialStored = readCollapseMap()[props.group.status];
  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(
    typeof initialStored === 'boolean' ? initialStored : null,
  );
  const isOpen = (): boolean => {
    if (props.forceOpen) return true;
    const ux = userExpanded();
    if (ux !== null) return ux;
    return !props.collapsedByDefault;
  };
  const toggle = (): void => {
    const next = !isOpen();
    setUserExpanded(next);
    writeCollapseEntry(props.group.status, next);
  };

  // Drop detection lives on the dragged Card (pointer hit-test on release);
  // the lane only needs to highlight when the pointer is over it. `overStatus`
  // is the shared module signal the dragging Card writes.
  const isEmpty = (): boolean => props.group.items.length === 0;
  return (
    <section
      class="group-block"
      classList={{ 'drag-over': overStatus() === props.group.status, collapsed: !isOpen() }}
      data-status={props.group.status}
      data-empty={isEmpty() ? 'true' : 'false'}
    >
      <header
        class="group-header"
        onClick={isEmpty() ? undefined : toggle}
        title={isEmpty() ? undefined : isOpen() ? 'Collapse section' : 'Expand section'}
      >
        <span class="caret" aria-hidden="true">
          {isOpen() ? '▾' : '▸'}
        </span>
        <span class="dot" aria-hidden="true" />
        <span class="name">{props.group.status}</span>
        <span class="count">{props.group.items.length}</span>
        <Show when={props.headerAction}>
          <span class="group-header-spacer" />
          <span class="group-header-action" onClick={(e) => e.stopPropagation()}>
            {props.headerAction!()}
          </span>
        </Show>
      </header>
      <Show when={isOpen() && !isEmpty()}>
        <Show
          when={props.bodySlot}
          fallback={
            <div class="group-body">
              <For each={props.group.items}>
                {(item) => (
                  <Card
                    item={item}
                    onOpen={props.onOpen}
                    onToggleStep={props.onToggleStep}
                    onWorkOn={props.onWorkOn}
                    onChangeStatus={onChangeStatus}
                    projectActions={props.projectActions}
                    onProjectAction={props.onProjectAction}
                  />
                )}
              </For>
            </div>
          }
        >
          {props.bodySlot!()}
        </Show>
      </Show>
    </section>
  );
}

/** Nested collapsible block used inside the Done section for the "Recent
 * (last 7 days)" pinned window and the per-close-month subgroups. Reuses
 * the GroupBlock chrome (caret, name, count) and the same persisted-collapse
 * map keyed under names like `done.recent` and `done.2026-05`, so user
 * toggles survive page reloads exactly like the outer status sections. */
export function SubGroup(props: {
  label: string;
  items: Project[];
  storageKey: string;
  defaultExpanded: boolean;
  /** Title attribute on the header — used to explain non-obvious shapes
   * like the Recent window's deliberate overlap with the month subgroups. */
  hint?: string;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onWorkOn: (project: Project) => void;
  /** Same shape as GroupBlock.onDropProject — threaded so cards in done
   * subgroups still respond to the Cmd/Ctrl+1..N keyboard shortcut. */
  onChangeStatus?: (path: string, newStatus: string) => void;
  projectActions?: ActionTemplate[];
  onProjectAction?: (project: Project, action: ActionTemplate) => void;
}) {
  const initialStored = readCollapseMap()[props.storageKey];
  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(
    typeof initialStored === 'boolean' ? initialStored : null,
  );
  const isOpen = (): boolean => {
    const ux = userExpanded();
    if (ux !== null) return ux;
    return props.defaultExpanded;
  };
  const toggle = (): void => {
    const next = !isOpen();
    setUserExpanded(next);
    writeCollapseEntry(props.storageKey, next);
  };
  return (
    <section class="group-block subgroup" classList={{ collapsed: !isOpen() }} data-status="done">
      <header
        class="group-header"
        onClick={toggle}
        title={props.hint ?? (isOpen() ? 'Collapse' : 'Expand')}
      >
        <span class="caret" aria-hidden="true">
          {isOpen() ? '▾' : '▸'}
        </span>
        <span class="name">{props.label}</span>
        <span class="count">{props.items.length}</span>
      </header>
      <Show when={isOpen()}>
        <div class="group-body">
          <For each={props.items}>
            {(item) => (
              <Card
                item={item}
                onOpen={props.onOpen}
                onToggleStep={props.onToggleStep}
                onWorkOn={props.onWorkOn}
                onChangeStatus={props.onChangeStatus}
                projectActions={props.projectActions}
                onProjectAction={props.onProjectAction}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

export function Card(props: {
  item: Project;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onWorkOn: (project: Project) => void;
  /** Keyboard alternative for the status drag: Cmd/Ctrl+1..N, where N is
   * KNOWN_STATUSES.length, sets the focused card's status. Wired only when
   * the parent group can also accept a drop (otherwise we'd let the user
   * move done-only subgroup cards into states the surrounding view never
   * reflects via drop). */
  onChangeStatus?: (path: string, newStatus: string) => void;
  draggable?: boolean;
  projectActions?: ActionTemplate[];
  onProjectAction?: (project: Project, action: ActionTemplate) => void;
}) {
  const [expanded, setExpanded] = createSignal(false);

  const handleHeaderClick = (event: MouseEvent) => {
    // A click synthesised at the end of a drag must not also open the card.
    if (draggedThisGesture) {
      draggedThisGesture = false;
      return;
    }
    if ((event.target as HTMLElement).closest('.step-toggle, .expander, .row-action')) return;
    props.onOpen(props.item);
  };

  // Pointer-based status drag. Native HTML5 drag-and-drop is silently broken
  // under Chromium's Wayland Ozone backend (electron#49907 / #42252), which
  // condash forces on Wayland sessions for crisp fractional-scaling text — so
  // the card drag is built on pointer events instead. We capture the pointer
  // on the source card and never reparent it mid-gesture (pointer-drag
  // invariant shared with condash-python); a translucent clone follows the
  // cursor and the drop lane is hit-tested from the pointer on release.
  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragging = false;
  // Set when a gesture crossed the move threshold; consumed by the click that
  // the browser synthesises on release so the drag doesn't also open the card.
  let draggedThisGesture = false;
  let ghost: HTMLElement | null = null;
  let ghostOffsetX = 0;
  let ghostOffsetY = 0;

  // Status lane under the pointer. The ghost is `pointer-events: none`, so
  // elementFromPoint sees the lane beneath it.
  const statusUnderPointer = (clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const block = el?.closest('.group-block[data-status]') as HTMLElement | null;
    return block?.dataset.status ?? null;
  };

  const positionGhost = (clientX: number, clientY: number) => {
    if (!ghost) return;
    ghost.style.transform = `translate(${clientX - ghostOffsetX}px, ${clientY - ghostOffsetY}px)`;
  };

  const beginDrag = (card: HTMLElement, clientX: number, clientY: number) => {
    dragging = true;
    draggedThisGesture = true;
    const sourceWidth = card.offsetWidth;
    ghostOffsetX = sourceWidth / 2;
    ghostOffsetY = 24;
    // A plain fixed-position clone we own renders exactly as styled (unlike a
    // setDragImage clone, whose opacity Chromium ignores).
    ghost = card.cloneNode(true) as HTMLElement;
    ghost.querySelectorAll('.title-actions, .steps-list').forEach((el) => el.remove());
    ghost.style.position = 'fixed';
    ghost.style.top = '0';
    ghost.style.left = '0';
    ghost.style.margin = '0';
    ghost.style.width = `${sourceWidth}px`;
    ghost.style.opacity = '0.55';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '99999';
    document.body.appendChild(ghost);
    positionGhost(clientX, clientY);
    // body flag lets every empty .group-block inflate its drop zone via CSS.
    document.body.dataset.dragging = 'project';
  };

  const endDrag = () => {
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    delete document.body.dataset.dragging;
    dragging = false;
    setOverStatus(null);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!isDraggable() || event.button !== 0) return;
    // Let interactive children (work-on dropdown, expander, step toggles)
    // keep their own click behaviour.
    if (
      (event.target as HTMLElement).closest('.title-actions, .expander, .step-toggle, .row-action')
    ) {
      return;
    }
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragging = false;
    draggedThisGesture = false;
    // No capture yet — a press that never crosses the threshold stays a plain
    // click, so card-open / child clicks are untouched. Capture is taken in
    // handlePointerMove the moment the drag actually begins.
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (dragPointerId !== event.pointerId) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < DRAG_THRESHOLD_PX) {
        return;
      }
      const card = event.currentTarget as HTMLElement;
      // Capture so move/up keep arriving even once the cursor leaves the card.
      card.setPointerCapture(event.pointerId);
      beginDrag(card, event.clientX, event.clientY);
    }
    positionGhost(event.clientX, event.clientY);
    setOverStatus(statusUnderPointer(event.clientX, event.clientY));
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (dragPointerId !== event.pointerId) return;
    const card = event.currentTarget as HTMLElement;
    const wasDragging = dragging;
    const targetStatus = wasDragging ? statusUnderPointer(event.clientX, event.clientY) : null;
    if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
    dragPointerId = null;
    endDrag();
    if (wasDragging && targetStatus && props.onChangeStatus && targetStatus !== props.item.status) {
      props.onChangeStatus(props.item.path, targetStatus);
    }
  };

  const handlePointerCancel = (event: PointerEvent) => {
    if (dragPointerId !== event.pointerId) return;
    const card = event.currentTarget as HTMLElement;
    if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
    dragPointerId = null;
    endDrag();
  };

  // Cmd/Ctrl+1..N maps to KNOWN_STATUSES[0..N-1]; ignore anything else so
  // typing inside any focusable child (search inputs etc.) is unaffected.
  // Also skip when an editable element is the actual event target.
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!props.onChangeStatus) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return;
    }
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > KNOWN_STATUSES.length) return;
    const next = KNOWN_STATUSES[digit - 1];
    if (props.item.status === next) return;
    event.preventDefault();
    event.stopPropagation();
    props.onChangeStatus(props.item.path, next);
  };

  const isDraggable = (): boolean => props.draggable !== false;
  const statusUnknown = (): boolean =>
    !(KNOWN_STATUSES as readonly string[]).includes(props.item.status);

  return (
    <article
      class="row"
      classList={{ draggable: isDraggable() }}
      title={props.item.path}
      aria-label={`${props.item.title}, ${props.item.status}`}
      data-status-card={props.item.status}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
    >
      <div class="row-head" onClick={handleHeaderClick}>
        {/* Row 1: kind glyph + title (left, can wrap to 2 lines) and the
            work-on action pinned to the right. */}
        <div class="title-row">
          <h3 class="title">
            <Show when={props.item.kind !== 'unknown' && props.item.kind !== 'project'}>
              <KindGlyph kind={props.item.kind} />
            </Show>
            <span class="title-text">{props.item.title}</span>
          </h3>
          <div class="title-actions">
            <ActionDropdownButton
              trigger={<TerminalIcon />}
              triggerTitle={`Paste 'work on ${props.item.slug}' into the focused terminal`}
              defaultLabel={`Work on ${props.item.slug.replace(/^\d{4}-\d{2}-\d{2}-/, '')}`}
              items={props.projectActions ?? []}
              onItem={(idx) => {
                if (idx === -1) {
                  props.onWorkOn(props.item);
                } else {
                  const action = props.projectActions?.[idx];
                  if (action) props.onProjectAction?.(props.item, action);
                }
              }}
              class="row-action work-on"
            />
          </div>
        </div>

        {/* Row 2: next task — the first open step's text. */}
        <Show when={nextOpenStep(props.item)} keyed>
          {(step) => (
            <p class="summary next-step" data-marker={markerClass(step.marker)}>
              <span class="next-step-marker" aria-hidden="true">
                <StepIcon marker={step.marker} />
              </span>
              {step.text}
            </p>
          )}
        </Show>

        {/* Row 3: step completion + apps + branch + dates. Last row on
            the card. The dates come from the slug (creation) and the
            most recent ## Timeline entry. */}
        <div class="meta meta-bottom">
          <Show when={hasSteps(props.item.stepCounts)}>
            <button
              class="meta-icon expander"
              data-complete={isStepCountsComplete(props.item.stepCounts) ? 'true' : undefined}
              aria-expanded={expanded()}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              title={`${props.item.steps.length} steps · click to ${expanded() ? 'collapse' : 'expand'}`}
            >
              <StepProgress counts={props.item.stepCounts} />
              <span class="expander-arrow">{expanded() ? '▾' : '▸'}</span>
            </button>
          </Show>
          <Show when={props.item.apps.length > 0}>
            <span class="meta-icon apps" title={props.item.apps.join(', ')}>
              <For each={props.item.apps}>
                {(app) => <span class={`app-pill ${appColorClass(app)}`}>{app}</span>}
              </For>
            </span>
          </Show>
          <Show when={props.item.branch}>
            <span class="meta-icon branch" title={`branch: ${props.item.branch}`}>
              {props.item.branch}
            </span>
          </Show>
          <Show when={statusUnknown()}>
            <span class="meta-icon warn" title={`Unknown status: ${props.item.status}`}>
              <WarnIcon />
              {props.item.status}
            </span>
          </Show>
          <span class="meta-spacer" />
        </div>
        {/* Row 4: slug (left) + date range (right). Canonical id + when the
            item ran — surfaces both at the bottom of every card so a cold
            reader gets context without opening it. The date used to live
            in row 3 too; pulled in here to avoid a duplicate. */}
        <div class="meta meta-bottom-slug">
          <span class="meta-icon slug" title={`slug: ${props.item.slug}`}>
            {props.item.slug}
          </span>
          <span class="meta-spacer" />
          <span
            class="meta-icon date"
            title={`first: ${firstDate(props.item)} · last: ${lastDate(props.item)}`}
          >
            {dateRangeLabel(props.item)}
          </span>
        </div>
      </div>
      <Show when={expanded() && props.item.steps.length > 0}>
        <ul class="steps-list">
          <For each={props.item.steps}>
            {(step) => (
              <li class={`step step-marker-${markerClass(step.marker)}`}>
                <button
                  class="step-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleStep(props.item, step);
                  }}
                  title={`${MARKER_LABEL[step.marker]} → ${MARKER_LABEL[nextMarker(step.marker)]}`}
                >
                  <StepIcon marker={step.marker} />
                </button>
                <span class="step-text">{step.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </article>
  );
}
