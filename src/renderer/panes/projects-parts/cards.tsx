import { createSignal, For, Show } from 'solid-js';
import type { ActionTemplate, Project, Step } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';
import { TerminalIcon } from '../../icons';
import { ActionSplitButton } from '../../action-split-button';
import {
  DRAG_MIME,
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
  const [over, setOver] = createSignal(false);
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

  const isAcceptable = (event: DragEvent): boolean => {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes(DRAG_MIME) : false;
  };

  const handleDragEnter = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    setOver(true);
  };

  const handleDragOver = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // Self-heal: dragenter/dragleave can race when a fixed-position ghost
    // hovers above the section, occasionally clearing the over state mid-
    // hover. dragover fires continuously while the cursor is on the
    // target, so re-asserting here keeps the highlight stable.
    setOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    setOver(false);
    const path = e.dataTransfer?.getData(DRAG_MIME);
    if (path) props.onDropProject(path, props.group.status);
  };

  const isEmpty = (): boolean => props.group.items.length === 0;
  return (
    <section
      class="group-block"
      classList={{ 'drag-over': over(), collapsed: !isOpen() }}
      data-status={props.group.status}
      data-empty={isEmpty() ? 'true' : 'false'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
    if ((event.target as HTMLElement).closest('.step-toggle, .expander, .row-action')) return;
    props.onOpen(props.item);
  };

  // Custom ghost state — Chromium in this Electron build ignores opacity
  // on setDragImage clones (the native snapshotter falls back to the
  // opaque source screenshot regardless of how we position or style the
  // element we hand to setDragImage). Instead: hide the native drag
  // image with a 1×1 transparent png, then render our own translucent
  // ghost div that follows the cursor via a document-level dragover
  // listener. The ghost is removed on dragend.
  let ghostElement: HTMLElement | null = null;
  let ghostOffsetX = 0;
  let ghostOffsetY = 0;
  const onGlobalDragOver = (e: DragEvent) => {
    if (!ghostElement) return;
    ghostElement.style.transform = `translate(${e.clientX - ghostOffsetX}px, ${e.clientY - ghostOffsetY}px)`;
  };

  const handleDragStart = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(DRAG_MIME, props.item.path);
    event.dataTransfer.effectAllowed = 'move';

    // Hide the native drag image — Chromium's auto-snapshot would
    // otherwise render an opaque copy of the source card.
    const blank = new Image();
    blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    event.dataTransfer.setDragImage(blank, 0, 0);

    // Build a translucent clone to use as our own ghost. Positioned
    // fixed so its transform follows the cursor regardless of scroll.
    const source = event.currentTarget as HTMLElement;
    const sourceWidth = source.offsetWidth;
    ghostOffsetX = sourceWidth / 2;
    ghostOffsetY = 24;
    ghostElement = source.cloneNode(true) as HTMLElement;
    ghostElement.style.position = 'fixed';
    ghostElement.style.top = '0';
    ghostElement.style.left = '0';
    ghostElement.style.width = `${sourceWidth}px`;
    ghostElement.style.opacity = '0.55';
    ghostElement.style.pointerEvents = 'none';
    ghostElement.style.zIndex = '99999';
    ghostElement.style.transform = `translate(${event.clientX - ghostOffsetX}px, ${event.clientY - ghostOffsetY}px)`;
    document.body.appendChild(ghostElement);
    document.addEventListener('dragover', onGlobalDragOver);

    // body flag lets every .group-block inflate its drop zone via CSS
    // without each section having to listen for a global drag.
    document.body.dataset.dragging = 'project';
  };

  const handleDragEnd = () => {
    delete document.body.dataset.dragging;
    if (ghostElement) {
      ghostElement.remove();
      ghostElement = null;
    }
    document.removeEventListener('dragover', onGlobalDragOver);
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
      title={props.item.path}
      data-status-card={props.item.status}
      draggable={isDraggable()}
      tabIndex={0}
      onDragStart={isDraggable() ? handleDragStart : undefined}
      onDragEnd={isDraggable() ? handleDragEnd : undefined}
      onKeyDown={handleKeyDown}
    >
      <div class="row-head" onClick={handleHeaderClick}>
        {/* Row 1: kind glyph + title (left, can wrap to 2 lines) and the
            work-on action pinned to the right. */}
        <div class="title-row">
          <h3 class="title">
            <Show when={props.item.kind !== 'unknown'}>
              <KindGlyph kind={props.item.kind} />
            </Show>
            <span class="title-text">{props.item.title}</span>
          </h3>
          <div class="title-actions">
            <ActionSplitButton
              primary={<TerminalIcon />}
              primaryTitle={`Paste 'work on ${props.item.slug}' into the focused terminal`}
              onPrimary={() => props.onWorkOn(props.item)}
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

        {/* Row 3: apps + branch — the project's where/in. Pulled out of
            the packed meta row so the card has a clean "context" line
            independent of step progress. */}
        <Show when={props.item.apps.length > 0 || props.item.branch}>
          <div class="meta meta-context">
            <Show when={props.item.apps.length > 0}>
              <span class="meta-icon apps" title={props.item.apps.join(', ')}>
                <span class="apps-text">{props.item.apps.join(', ')}</span>
              </span>
            </Show>
            <Show when={props.item.branch}>
              <span class="meta-icon branch" title={`branch: ${props.item.branch}`}>
                <span class="branch-text">{props.item.branch}</span>
              </span>
            </Show>
          </div>
        </Show>

        {/* Row 4: step completion (left) + first/last dates (right).
            Last row on the card. The dates come from the slug
            (creation) and the most recent ## Timeline entry. */}
        <div class="meta meta-bottom">
          <Show when={hasSteps(props.item.stepCounts)}>
            <button
              class="meta-icon expander"
              data-complete={isStepCountsComplete(props.item.stepCounts) ? 'true' : undefined}
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
          <Show when={statusUnknown()}>
            <span class="meta-icon warn" title={`Unknown status: ${props.item.status}`}>
              <WarnIcon />
              {props.item.status}
            </span>
          </Show>
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
