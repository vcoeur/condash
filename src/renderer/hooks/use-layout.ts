import { createSignal } from 'solid-js';
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

export interface UseLayoutDeps {
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseLayout {
  layout: () => LayoutState;
  setLayoutState: (next: LayoutState) => void;
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
  const [layout, setLayoutState] = createSignal<LayoutState>({ ...DEFAULT_LAYOUT });

  void getBootstrap()
    // Merge over the defaults so a layout persisted before a field existed
    // (e.g. `leftView`) is back-filled rather than landing as `undefined`.
    .then((boot) => setLayoutState({ ...DEFAULT_LAYOUT, ...boot.layout }))
    .catch((err) => deps.flashToast(`Could not load layout: ${(err as Error).message}`, 'error'));

  const updateLayout = (patch: Partial<LayoutState>): void => {
    const next = { ...layout(), ...patch };
    setLayoutState(next);
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
    setLayoutState,
    updateLayout,
    toggleProjects,
    toggleTerminal,
    toggleLeftView,
    selectWorking,
    ensureTerminalOpen,
    topBandVisible,
    topBandStyle,
    startSplitterDrag,
  };
}
