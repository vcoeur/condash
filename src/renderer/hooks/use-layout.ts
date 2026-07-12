import { createMemo, createSignal } from 'solid-js';
import type { LayoutState, LeftView, WorkingSurface } from '@shared/types';
import { getBootstrap } from '../bootstrap';

/** Renderer-side default; mirrors the main-process `DEFAULT_LAYOUT`. Used both
 *  for the pre-load signal value and to back-fill fields a persisted layout
 *  predates (e.g. `leftView`). */
const DEFAULT_LAYOUT: LayoutState = {
  projects: true,
  leftView: 'projects',
  working: 'code',
  terminal: true,
  projectsWidth: 320,
};

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
      return { 'grid-template-columns': `${l.projectsWidth}px 4px 1fr` };
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
    const min = 160;
    let pendingX: number | null = null;
    let rafId: number | null = null;
    let lastWidth = layout().projectsWidth;
    const flush = (): void => {
      rafId = null;
      if (pendingX === null) return;
      const desired = pendingX - rect.left;
      const clamped = Math.max(min, Math.min(rect.width - min - 4, desired));
      lastWidth = Math.round(clamped);
      band.style.gridTemplateColumns = `${lastWidth}px 4px 1fr`;
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
      updateLayout({ projectsWidth: lastWidth });
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
