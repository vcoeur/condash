import { createMemo, createSignal } from 'solid-js';
import type { LayoutState, LeftView, WorkingSurface } from '@shared/types';
import { DEFAULT_PROJECTS_SPLIT, MAX_PROJECTS_SPLIT, MIN_PROJECTS_SPLIT } from '@shared/types';
import { getBootstrap } from '../bootstrap';

/** Renderer-side default; mirrors the main-process `DEFAULT_LAYOUT`. Used both
 *  for the pre-load signal value and to back-fill fields a persisted layout
 *  predates (e.g. `leftView`). */
const DEFAULT_LAYOUT: LayoutState = {
  projects: true,
  leftView: 'projects',
  working: 'code',
  terminal: true,
  projectsSplit: DEFAULT_PROJECTS_SPLIT,
};

/** Splitter thickness in px — mirrored in the grid template. */
const SPLITTER_PX = 4;

/** Neither pane may be squeezed below this. It is also what guarantees the
 *  splitter stays on screen: capping the Projects column at
 *  `100% - MIN_PANE_PX - SPLITTER_PX` keeps the handle at least that far from
 *  the right edge, so a narrowed window can always be dragged back. */
const MIN_PANE_PX = 200;

/**
 * Keep a stored fraction inside the schema's bounds.
 *
 * These bounds must stay **looser** than the px clamp in `splitColumns`, which
 * is the constraint that actually decides where the splitter can sit. If the
 * fraction bound were the tighter of the two they would disagree on any band
 * wider than ~2000px: dragging fully left pins the pane at 200px, but 200/2560
 * is 0.078, and rounding that up to a 0.1 floor would re-render the pane at
 * 256px — the handle visibly jumping ~56px the instant the mouse is released,
 * with the user unable to park it at the minimum they were just shown.
 */
export function clampSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_PROJECTS_SPLIT;
  return Math.min(MAX_PROJECTS_SPLIT, Math.max(MIN_PROJECTS_SPLIT, fraction));
}

/**
 * Grid template for the top band's split state.
 *
 * The Projects column is a **percentage** so the split holds its proportions
 * across a window resize, wrapped in `clamp()` so neither pane collapses. When
 * the band is too narrow to honour both minimums, CSS `clamp()` resolves to its
 * minimum — Projects gets `MIN_PANE_PX` and the working surface takes what is
 * left, which still leaves the splitter visible and grabbable.
 */
export function splitColumns(fraction: number): string {
  const percent = (clampSplit(fraction) * 100).toFixed(4);
  const cap = `calc(100% - ${MIN_PANE_PX + SPLITTER_PX}px)`;
  return `clamp(${MIN_PANE_PX}px, ${percent}%, ${cap}) ${SPLITTER_PX}px 1fr`;
}

/**
 * Apply the modal auto-collapse mask to a persisted layout for display: while
 * `autoCollapsed` the terminal reads as closed; otherwise the layout passes
 * through by reference (so the display memo stays referentially stable). The
 * input is never mutated, which is what keeps the collapse out of persistence —
 * `updateLayout` reads the untouched persisted preference, not the masked view.
 *
 * @param base The persisted layout (the saved terminal preference).
 * @param autoCollapsed Whether a modal is currently auto-collapsing the terminal.
 * @returns The layout to display; `base` unchanged when not collapsed.
 */
export function maskTerminal(base: LayoutState, autoCollapsed: boolean): LayoutState {
  return autoCollapsed ? { ...base, terminal: false } : base;
}

export interface UseLayoutDeps {
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseLayout {
  layout: () => LayoutState;
  /** Apply a layout patch and persist it. The persistence is fire-and-
   *  forget: any settings.json write failure surfaces as a toast but the
   *  UI state is the source of truth for the session. */
  updateLayout: (patch: Partial<LayoutState>) => void;
  toggleProjects: () => void;
  toggleTerminal: () => void;
  /** Left activity-rail item action: clicking the active view (band visible +
   *  that view) hides the band; clicking the other shows the band on it.
   *  Mirrors the right strip's mutually-exclusive working-surface toggle. */
  toggleLeftView: (view: LeftView) => void;
  selectWorking: (next: WorkingSurface) => void;
  ensureTerminalOpen: () => void;
  /** Set the ephemeral modal auto-collapse mask: `true` hides the terminal for
   *  display only (the persisted preference is untouched), `false` reveals it.
   *  Cleared by any user terminal toggle. Driven by the height-modal effect in
   *  App so a doc/overlay reclaims the terminal's band while it is open. */
  setTerminalAutoCollapsed: (collapsed: boolean) => void;
  /** Any of the three top-band panes is on — when all three are off only
   *  the Terminal renders and the top band collapses entirely. */
  topBandVisible: () => boolean;
  /** Grid columns inside the top band. Three states:
   *   - both Projects and working visible: split with the user-resizable
   *     Projects width on the left.
   *   - one hidden: the other fills.
   *   - none visible: top band is collapsed (handled at the wrapper). */
  topBandStyle: () => Record<string, string>;
  /** Drag the Projects ↔ working-surface splitter. Coalesces mousemove
   *  updates: writes grid columns straight to the DOM at most once per
   *  frame and skips the Solid signal during the drag to keep INP
   *  bounded on heavily-populated pages. Final width is committed to
   *  layout state on mouseup. */
  startSplitterDrag: (event: MouseEvent, band: HTMLDivElement | undefined) => void;
}

export function useLayout(deps: UseLayoutDeps): UseLayout {
  // Composite-layout state — replaces the prior single-`tab` selector.
  // Default mirrors the persisted server-side default until the real
  // value loads (avoids a frame of empty UI).
  // Persisted layout — the source of truth written to settings.json. Its
  // `terminal` field is the user's saved preference; the modal auto-collapse
  // never writes here (it toggles `autoCollapsed` below), so a transient
  // collapse can never leak into persistence.
  const [persisted, setPersisted] = createSignal<LayoutState>({ ...DEFAULT_LAYOUT });

  // Ephemeral modal auto-collapse mask — true while a height-taking modal has
  // collapsed the terminal. Display-only: it never persists, and any user
  // terminal toggle (through `updateLayout`) clears it.
  const [autoCollapsed, setAutoCollapsed] = createSignal(false);

  // The layout every consumer reads: the persisted state with the terminal
  // masked shut while the auto-collapse is active. Persistence reads `persisted`
  // directly, so the mask is transparent to the UI yet invisible to settings.json.
  const layout = createMemo<LayoutState>(() => maskTerminal(persisted(), autoCollapsed()));

  void getBootstrap()
    // Merge over the defaults so a layout persisted before a field existed
    // (e.g. `leftView`) is back-filled rather than landing as `undefined`.
    .then((boot) => setPersisted({ ...DEFAULT_LAYOUT, ...boot.layout }))
    .catch((err) => deps.flashToast(`Could not load layout: ${(err as Error).message}`, 'error'));

  const updateLayout = (patch: Partial<LayoutState>): void => {
    // A user-intended terminal change supersedes an active modal auto-collapse.
    if (patch.terminal !== undefined) setAutoCollapsed(false);
    const next = { ...persisted(), ...patch };
    setPersisted(next);
    void window.condash.setLayout(next).catch((err) => {
      deps.flashToast(`Could not persist layout: ${(err as Error).message}`, 'error');
    });
  };

  const toggleProjects = (): void => updateLayout({ projects: !layout().projects });
  const toggleTerminal = (): void => updateLayout({ terminal: !layout().terminal });
  const toggleLeftView = (view: LeftView): void => {
    if (layout().projects && layout().leftView === view) {
      updateLayout({ projects: false });
    } else {
      updateLayout({ projects: true, leftView: view });
    }
  };
  const selectWorking = (next: WorkingSurface): void => updateLayout({ working: next });
  const ensureTerminalOpen = (): void => {
    if (!layout().terminal) updateLayout({ terminal: true });
  };
  const setTerminalAutoCollapsed = (collapsed: boolean): void => {
    setAutoCollapsed(collapsed);
  };

  const topBandVisible = (): boolean => layout().projects || layout().working !== null;

  const topBandStyle = (): Record<string, string> => {
    const l = layout();
    if (l.projects && l.working !== null) {
      return { 'grid-template-columns': splitColumns(l.projectsSplit) };
    }
    return { 'grid-template-columns': '1fr' };
  };

  const startSplitterDrag = (event: MouseEvent, band: HTMLDivElement | undefined): void => {
    if (!band) return;
    // Left mouse only — right/middle should fall through to the OS
    // context menu / paste, not start a resize.
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = band.getBoundingClientRect();
    let pendingX: number | null = null;
    let rafId: number | null = null;
    let lastWidth = clampSplit(layout().projectsSplit) * rect.width;
    const flush = (): void => {
      rafId = null;
      if (pendingX === null) return;
      const desired = pendingX - rect.left;
      const cap = rect.width - MIN_PANE_PX - SPLITTER_PX;
      // `cap` can fall below MIN_PANE_PX on a very narrow window; Math.max wins
      // that tie, matching how CSS clamp() resolves an inverted range.
      const clamped = Math.max(MIN_PANE_PX, Math.min(cap, desired));
      lastWidth = Math.round(clamped);
      // Straight to the DOM in px during the drag — the pointer is the source
      // of truth here, and skipping the signal keeps INP bounded.
      band.style.gridTemplateColumns = `${lastWidth}px ${SPLITTER_PX}px 1fr`;
    };
    const onMove = (e: MouseEvent): void => {
      pendingX = e.clientX;
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Commit as a fraction of the band so the split survives a resize. Write
      // the resolved template back explicitly too: the drag left a px value on
      // the element, and relying on Solid to diff it away would leave the pane
      // pinned if the new fraction happened to render the same string.
      const split = clampSplit(
        rect.width > 0 ? lastWidth / rect.width : DEFAULT_LAYOUT.projectsSplit,
      );
      band.style.gridTemplateColumns = splitColumns(split);
      updateLayout({ projectsSplit: split });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return {
    layout,
    updateLayout,
    toggleProjects,
    toggleTerminal,
    toggleLeftView,
    selectWorking,
    ensureTerminalOpen,
    setTerminalAutoCollapsed,
    topBandVisible,
    topBandStyle,
    startSplitterDrag,
  };
}
